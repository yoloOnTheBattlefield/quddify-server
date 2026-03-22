const logger = require("../utils/logger").child({ module: "stripe" });
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const Account = require("../models/Account");
const Payment = require("../models/Payment");
const Lead = require("../models/Lead");
const { encrypt, decrypt } = require("../utils/crypto");

// ---------------------------------------------------------------------------
// Helper: match a payment to a lead by email
// ---------------------------------------------------------------------------
async function matchLeadByEmail(accountId, email) {
  if (!email) return null;
  const emailLower = email.toLowerCase();
  // Match against primary email or emails array
  return Lead.findOne({
    account_id: accountId,
    $or: [
      { email: { $regex: new RegExp(`^${emailLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } },
      { emails: { $regex: new RegExp(`^${emailLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } },
    ],
  });
}

// ---------------------------------------------------------------------------
// Helper: extract payment data from different Stripe event types
// ---------------------------------------------------------------------------
function extractPaymentData(eventType, data) {
  switch (eventType) {
    case "checkout.session.completed": {
      const session = data;
      return {
        amount: session.amount_total || 0,
        currency: session.currency || "usd",
        customer_email: session.customer_details?.email || session.customer_email || null,
        customer_name: session.customer_details?.name || null,
        description: session.metadata?.product_name || session.payment_link ? "Checkout" : "Checkout Session",
        stripe_customer_id: session.customer || null,
        stripe_payment_intent_id: session.payment_intent || null,
      };
    }
    case "invoice.paid": {
      const invoice = data;
      const lineDesc = invoice.lines?.data?.[0]?.description || null;
      return {
        amount: invoice.amount_paid || 0,
        currency: invoice.currency || "usd",
        customer_email: invoice.customer_email || null,
        customer_name: invoice.customer_name || null,
        description: lineDesc || invoice.description || "Invoice",
        stripe_customer_id: invoice.customer || null,
        stripe_payment_intent_id: invoice.payment_intent || null,
      };
    }
    case "charge.succeeded": {
      const charge = data;
      return {
        amount: charge.amount || 0,
        currency: charge.currency || "usd",
        customer_email: charge.billing_details?.email || charge.receipt_email || null,
        customer_name: charge.billing_details?.name || null,
        description: charge.description || "Charge",
        stripe_customer_id: charge.customer || null,
        stripe_payment_intent_id: charge.payment_intent || null,
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: auto-close lead on payment
// ---------------------------------------------------------------------------
async function autoCloseLead(lead, amountCents, paymentDate) {
  const updates = {};
  if (!lead.closed_at) updates.closed_at = paymentDate;
  // Add to contract_value (convert cents to dollars)
  const amountDollars = amountCents / 100;
  updates.contract_value = (lead.contract_value || 0) + amountDollars;

  if (Object.keys(updates).length > 0) {
    await Lead.findByIdAndUpdate(lead._id, { $set: updates });
  }
}

// ---------------------------------------------------------------------------
// POST /api/stripe/webhook?account=GHL_ID — Public Stripe webhook
// ---------------------------------------------------------------------------
router.post("/webhook", async (req, res) => {
  try {
    const accountGhl = req.query.account;
    if (!accountGhl) {
      return res.status(400).json({ error: "Missing account param" });
    }

    const account = await Account.findOne({ ghl: accountGhl });
    if (!account || !account.stripe_webhook_secret) {
      return res.status(400).json({ error: "Stripe not configured for this account" });
    }

    // Verify webhook signature
    const sig = req.headers["stripe-signature"];
    const secret = decrypt(account.stripe_webhook_secret);
    let event;
    try {
      const stripe = new Stripe(secret); // secret is only used for verification, not API calls
      event = Stripe.webhooks.constructEvent(req.rawBody, sig, secret);
    } catch (err) {
      logger.warn({ err: err.message }, "Stripe signature verification failed");
      return res.status(400).json({ error: "Invalid signature" });
    }

    const eventType = event.type;
    const supportedEvents = ["checkout.session.completed", "invoice.paid", "charge.succeeded"];
    if (!supportedEvents.includes(eventType)) {
      return res.json({ received: true, ignored: true });
    }

    const paymentData = extractPaymentData(eventType, event.data.object);
    if (!paymentData) {
      return res.json({ received: true, ignored: true });
    }

    // Skip zero-amount events (e.g. free trials)
    if (paymentData.amount <= 0) {
      return res.json({ received: true, ignored: true, reason: "zero_amount" });
    }

    // Match to lead
    const lead = await matchLeadByEmail(account.ghl, paymentData.customer_email);

    // Create payment record (unique stripe_event_id prevents duplicates)
    try {
      const payment = await Payment.create({
        account_id: account._id,
        lead_id: lead?._id || null,
        stripe_event_id: event.id,
        stripe_event_type: eventType,
        amount: paymentData.amount,
        currency: paymentData.currency,
        customer_email: paymentData.customer_email,
        customer_name: paymentData.customer_name,
        description: paymentData.description,
        stripe_customer_id: paymentData.stripe_customer_id,
        stripe_payment_intent_id: paymentData.stripe_payment_intent_id,
        payment_date: new Date(event.created * 1000),
      });

      if (lead) {
        await autoCloseLead(lead, paymentData.amount, new Date(event.created * 1000));
        logger.info({ paymentId: payment._id, leadId: lead._id }, "Payment matched to lead");
      } else {
        logger.info({ paymentId: payment._id, email: paymentData.customer_email }, "Payment created (no lead match)");
      }
    } catch (err) {
      if (err.code === 11000) {
        // Duplicate event — already processed
        logger.info({ eventId: event.id }, "Duplicate Stripe event ignored");
        return res.json({ received: true, duplicate: true });
      }
      throw err;
    }

    res.json({ received: true });
  } catch (err) {
    logger.error({ err }, "Stripe webhook error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stripe/connect — Save webhook secret (authenticated)
// ---------------------------------------------------------------------------
router.post("/connect", async (req, res) => {
  try {
    const { webhook_secret } = req.body;
    if (!webhook_secret) {
      return res.status(400).json({ error: "Missing webhook_secret" });
    }

    await Account.findByIdAndUpdate(req.account._id, {
      stripe_webhook_secret: encrypt(webhook_secret),
    });

    logger.info({ accountId: req.account._id }, "Stripe webhook secret saved");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to save Stripe webhook secret");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/stripe/disconnect — Remove webhook secret (authenticated)
// ---------------------------------------------------------------------------
router.delete("/disconnect", async (req, res) => {
  try {
    await Account.findByIdAndUpdate(req.account._id, {
      stripe_webhook_secret: null,
    });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to disconnect Stripe");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stripe/payments/:leadId — Get payments for a lead (authenticated)
// ---------------------------------------------------------------------------
router.get("/payments/:leadId", async (req, res) => {
  try {
    const payments = await Payment.find({ lead_id: req.params.leadId })
      .sort({ payment_date: -1 })
      .lean();
    res.json(payments);
  } catch (err) {
    logger.error({ err }, "Failed to fetch payments");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stripe/import — Bulk import payments from CSV (authenticated)
// ---------------------------------------------------------------------------
router.post("/import", async (req, res) => {
  try {
    const accountId = req.account._id;
    const accountGhl = req.account.ghl;
    const { rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }

    const results = { imported: 0, matched: 0, skipped: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      // Require amount and date
      if (!row.amount && row.amount !== 0) {
        results.errors.push({ row: rowNum, reason: "Missing amount" });
        results.skipped++;
        continue;
      }

      const paymentDate = row.payment_date ? new Date(row.payment_date) : null;
      if (!paymentDate || isNaN(paymentDate.getTime())) {
        results.errors.push({ row: rowNum, reason: `Invalid date: ${row.payment_date}` });
        results.skipped++;
        continue;
      }

      // Skip non-paid statuses
      if (row.status) {
        const s = row.status.toLowerCase().trim();
        if (s !== "paid" && s !== "succeeded" && s !== "complete") {
          results.skipped++;
          continue;
        }
      }

      // Parse amount — could be in dollars (from CSV) or cents
      let amountCents = Math.round(Number(row.amount) * 100);
      if (isNaN(amountCents)) {
        results.errors.push({ row: rowNum, reason: `Invalid amount: ${row.amount}` });
        results.skipped++;
        continue;
      }

      const email = row.customer_email || null;
      const lead = email ? await matchLeadByEmail(accountGhl, email) : null;

      const eventId = row.stripe_event_id || row.id || `import-${accountId}-${i}-${Date.now()}`;

      try {
        await Payment.create({
          account_id: accountId,
          lead_id: lead?._id || null,
          stripe_event_id: eventId,
          stripe_event_type: "import",
          amount: amountCents,
          currency: (row.currency || "usd").toLowerCase(),
          customer_email: email,
          customer_name: row.customer_name || null,
          description: row.description || null,
          stripe_customer_id: row.stripe_customer_id || null,
          payment_date: paymentDate,
        });

        results.imported++;

        if (lead) {
          await autoCloseLead(lead, amountCents, paymentDate);
          results.matched++;
        }
      } catch (err) {
        if (err.code === 11000) {
          results.skipped++;
        } else {
          results.errors.push({ row: rowNum, reason: err.message });
          results.skipped++;
        }
      }
    }

    logger.info({ imported: results.imported, matched: results.matched, skipped: results.skipped }, "Stripe payments imported");
    res.json(results);
  } catch (err) {
    logger.error({ err }, "Failed to import payments");
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

const logger = require("../utils/logger").child({ module: "calendly" });
const express = require("express");
const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const Booking = require("../models/Booking");
const Account = require("../models/Account");
const { encrypt, decrypt } = require("../utils/crypto");
const { notifyNewLead } = require("../services/telegramNotifier");

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the account for an incoming Calendly webhook and fetch event data.
 *
 * Returns { account, eventData } where eventData contains the scheduled event
 * details (start_time, end_time, etc.) if available.
 *
 * Priority:
 *   1. ?account= query param on the webhook URL (most reliable, baked in)
 *   2. Calendly API fallback — match event membership to stored user URI
 *   3. utm_source as account GHL (backward compat)
 */
async function resolveAccountAndEvent(utmSource, queryAccount, scheduledEventUri) {
  let eventData = null;

  // Priority 1 — ?account= query param (most reliable, baked into webhook URL)
  if (queryAccount) {
    const account = await Account.findOne({ ghl: queryAccount });
    if (account) {
      // Fetch event data if we have a token and event URI
      if (scheduledEventUri && account.calendly_token) {
        eventData = await fetchCalendlyEvent(account, scheduledEventUri);
      }
      return { account, eventData };
    }
  }

  // Priority 2 — Calendly API fallback (match event membership)
  if (scheduledEventUri) {
    const accounts = await Account.find({
      calendly_user_uri: { $ne: null },
      calendly_token: { $ne: null },
    }).lean();

    for (const acct of accounts) {
      try {
        const token = decrypt(acct.calendly_token);
        const resp = await fetch(scheduledEventUri, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const memberUris = (data.resource?.event_memberships || []).map(
          (m) => m.user,
        );
        if (memberUris.includes(acct.calendly_user_uri)) {
          eventData = data.resource || null;
          return { account: await Account.findById(acct._id), eventData };
        }
      } catch {
        continue;
      }
    }
  }

  // Priority 3 — utm_source as account GHL (backward compatibility)
  if (utmSource) {
    const account = await Account.findOne({ ghl: utmSource });
    if (account) return { account, eventData };
  }

  return { account: null, eventData };
}

/**
 * Fetch scheduled event details from Calendly API.
 */
async function fetchCalendlyEvent(account, scheduledEventUri) {
  try {
    const token = decrypt(account.calendly_token);
    const resp = await fetch(scheduledEventUri, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.resource || null;
  } catch (err) {
    logger.error({ err }, "Failed to fetch Calendly event");
    return null;
  }
}

/**
 * Fire the account's GHL webhook (if configured) after a booking.
 */
async function callGhlWebhook(account, lead) {
  const webhookUrl = account?.ghl_lead_booked_webhook;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_id: lead.contact_id || null,
        email: lead.email || null,
        first_name: lead.first_name || null,
        last_name: lead.last_name || null,
      }),
    });
    logger.info({ webhookUrl, leadId: lead._id }, "GHL webhook called");
  } catch (err) {
    logger.error({ err }, "GHL webhook error");
  }
}

/**
 * Sync booked status to a linked OutboundLead (if any).
 */
async function syncOutboundLead(lead) {
  if (!lead.outbound_lead_id) return;
  await OutboundLead.findByIdAndUpdate(lead.outbound_lead_id, {
    booked: true,
    booked_at: lead.booked_at,
  }).catch((err) =>
    logger.error({ err }, "Failed to sync booked to outbound lead"),
  );
}

/**
 * Try to match a newly created lead to an existing OutboundLead by email or
 * IG username (extracted from Calendly Q&A).
 */
async function tryLinkOutboundLead(lead, accountObjectId, questionsAndAnswers) {
  if (lead.outbound_lead_id) return lead;

  const orConditions = [];
  if (lead.email) {
    orConditions.push({ email: { $regex: new RegExp(`^${lead.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } });
  }

  // Extract IG username from Q&A answers (common field names)
  const igAnswer = (questionsAndAnswers || []).find((qa) =>
    /instagram|ig\s|ig_|handle/i.test(qa.question),
  );
  if (igAnswer?.answer) {
    const username = igAnswer.answer.replace(/^@/, "").trim().toLowerCase();
    if (username) {
      orConditions.push({ username: { $regex: new RegExp(`^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } });
    }
  }

  if (orConditions.length === 0) return lead;

  const outbound = await OutboundLead.findOne({
    account_id: accountObjectId,
    $or: orConditions,
  });

  if (outbound) {
    lead = await Lead.findByIdAndUpdate(
      lead._id,
      { outbound_lead_id: outbound._id },
      { new: true },
    );
    await OutboundLead.findByIdAndUpdate(outbound._id, {
      booked: true,
      booked_at: new Date(),
    });
    logger.info(
      { leadId: lead._id, outboundLeadId: outbound._id },
      "Auto-linked inbound lead to outbound lead",
    );
  }

  return lead;
}

/**
 * Create or update a Booking record from a Calendly event.
 */
async function upsertBooking(account, lead, { scheduledEventUri, inviteeUri, eventData, email, name, utmSource, utmMedium, utmCampaign }) {
  if (!scheduledEventUri) return null;

  const bookingDate = eventData?.start_time
    ? new Date(eventData.start_time)
    : new Date();

  try {
    const booking = await Booking.findOneAndUpdate(
      { calendly_event_uri: scheduledEventUri, account_id: account._id },
      {
        $set: {
          lead_id: lead._id,
          outbound_lead_id: lead.outbound_lead_id || null,
          source: lead.outbound_lead_id ? "outbound" : "inbound",
          contact_name: name || "",
          email: email || null,
          booking_date: bookingDate,
          status: "scheduled",
          utm_source: utmSource,
          utm_medium: utmMedium,
          utm_campaign: utmCampaign,
          calendly_event_uri: scheduledEventUri,
          calendly_invitee_uri: inviteeUri,
        },
        $setOnInsert: { account_id: account._id },
      },
      { upsert: true, new: true },
    );
    logger.info({ bookingId: booking._id, leadId: lead._id }, "Booking created/updated from Calendly");
    return booking;
  } catch (err) {
    logger.error({ err }, "Failed to upsert booking from Calendly");
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /calendly/add — Register Calendly webhook subscription
// ---------------------------------------------------------------------------
router.post("/add", async (req, res) => {
  try {
    const {
      token,
      user: { ghl: accountId },
    } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }
    if (!accountId) {
      return res.status(400).json({ error: "Missing accountId" });
    }

    // Step 1: Get user info from Calendly
    const userResponse = await fetch("https://api.calendly.com/users/me", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!userResponse.ok) {
      const errorData = await userResponse.json();
      logger.error("Calendly user fetch error:", errorData);
      return res
        .status(userResponse.status)
        .json({ error: "Failed to fetch Calendly user", details: errorData });
    }

    const userData = await userResponse.json();
    const organization = userData.resource.current_organization;
    const userUri = userData.resource.uri;

    logger.info("Calendly user:", { organization, userUri });

    // Step 2: Create webhook subscription (include account id in URL for fallback resolution)
    const webhookResponse = await fetch(
      "https://api.calendly.com/webhook_subscriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: `https://quddify-server.vercel.app/api/calendly?account=${accountId}`,
          events: ["invitee.created", "invitee.canceled"],
          organization: organization,
          scope: "user",
          user: userUri,
        }),
      },
    );

    const webhookData = await webhookResponse.json();

    if (!webhookResponse.ok) {
      logger.error("Calendly webhook subscription error:", webhookData);
      return res.status(webhookResponse.status).json({
        error: "Failed to create webhook subscription",
        details: webhookData,
      });
    }

    logger.info("Webhook subscription created:", webhookData);

    // Step 3: Save token + user URI to the account
    await Account.findOneAndUpdate(
      { ghl: accountId },
      { calendly_token: encrypt(token), calendly_user_uri: userUri },
    );

    res.json({ success: true, webhook: webhookData });
  } catch (error) {
    logger.error("Calendly add error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/calendly — Calendly webhook (public, no auth)
//
// Handles events:
//   invitee.created — Create/update lead + auto-create Booking
//   invitee.canceled — Cancel the associated Booking
// ---------------------------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const { event, payload } = req.body;

    const utmSource = payload?.tracking?.utm_source || null;
    const utmMedium = payload?.tracking?.utm_medium || null;
    const utmCampaign = payload?.tracking?.utm_campaign || null;
    const email = payload?.email || null;
    const name = payload?.name || null;
    const questionsAndAnswers = payload?.questions_and_answers || [];
    const scheduledEventUri = payload?.scheduled_event || null;
    const inviteeUri = payload?.uri || null;

    // ---- Handle cancellation ----
    if (event === "invitee.canceled") {
      logger.info({ scheduledEventUri }, "Calendly cancellation received");

      if (!scheduledEventUri) {
        return res.json({ success: true, message: "No event URI to cancel" });
      }

      // Resolve account to scope the booking lookup
      const { account } = await resolveAccountAndEvent(
        utmSource,
        req.query.account,
        null, // don't fetch event data for cancellations
      );

      if (account) {
        const booking = await Booking.findOneAndUpdate(
          { calendly_event_uri: scheduledEventUri, account_id: account._id },
          { status: "cancelled", cancelled_at: new Date() },
          { new: true },
        );
        if (booking) {
          logger.info({ bookingId: booking._id }, "Booking cancelled via Calendly");
        }
      }

      return res.json({ success: true, cancelled: true });
    }

    // ---- Only process invitee.created from here ----
    if (event !== "invitee.created") {
      logger.info({ event }, "Event ignored");
      return res.json({ success: true, message: "Event ignored" });
    }

    // utm_medium may be a contact_id (legacy ManyChat flow) or a marketing
    // detail (e.g. video title). We try to match it as contact_id first.
    const contactId = utmMedium || null;

    logger.info(
      { contactId, utmSource, utmMedium, email, name, scheduledEventUri },
      "Calendly webhook received",
    );

    // ---- Resolve account + event data ----
    const { account, eventData } = await resolveAccountAndEvent(
      utmSource,
      req.query.account,
      scheduledEventUri,
    );

    if (!account) {
      logger.warn("Could not resolve account for Calendly webhook");
      return res.status(400).json({ error: "Could not resolve account" });
    }

    const accountId = account.ghl;

    // ---- Scenario 1: Existing lead matched by contact_id ----
    if (contactId) {
      const existingLead = await Lead.findOneAndUpdate(
        { contact_id: contactId, account_id: accountId },
        {
          booked_at: new Date(),
          ...(email && { email }),
          questions_and_answers: questionsAndAnswers,
          ...(utmSource && { utm_source: utmSource }),
          ...(utmMedium && { utm_medium: utmMedium }),
        },
        { new: true },
      );

      if (existingLead) {
        logger.info({ leadId: existingLead._id }, "Existing lead updated");

        // Auto-link outbound if not already linked
        const linkedLead = await tryLinkOutboundLead(existingLead, account._id, questionsAndAnswers);

        await syncOutboundLead(linkedLead);
        await callGhlWebhook(account, linkedLead);

        // Auto-create Booking
        await upsertBooking(account, linkedLead, {
          scheduledEventUri, inviteeUri, eventData, email, name,
          utmSource, utmMedium, utmCampaign,
        });

        // Telegram notification (fire-and-forget)
        const outbound = linkedLead.outbound_lead_id
          ? await OutboundLead.findById(linkedLead.outbound_lead_id).lean()
          : null;
        notifyNewLead(account, linkedLead, outbound).catch((err) =>
          logger.error({ err }, "Telegram notify error"),
        );
        return res.json({ success: true, lead: linkedLead });
      }

      // contact_id present but no matching lead — fall through to create
      logger.info({ contactId }, "No existing lead for contact_id, creating");
    }

    // ---- Scenarios 2 & 3: Create a new lead ----
    const nameParts = (name || "").trim().split(/\s+/);
    const firstName = nameParts[0] || null;
    const lastName = nameParts.slice(1).join(" ") || null;

    // Build the upsert filter: deduplicate by email+account when we have an
    // email, otherwise by contact_id+account, otherwise just create.
    let upsertFilter = null;
    if (email) {
      upsertFilter = { email, account_id: accountId };
    } else if (contactId) {
      upsertFilter = { contact_id: contactId, account_id: accountId };
    }

    const leadData = {
      first_name: firstName,
      last_name: lastName,
      ...(email && { email }),
      ...(contactId && { contact_id: contactId }),
      account_id: accountId,
      source: "calendly",
      booked_at: new Date(),
      questions_and_answers: questionsAndAnswers,
      ...(utmSource && { utm_source: utmSource }),
      ...(utmMedium && { utm_medium: utmMedium }),
    };

    let lead;
    if (upsertFilter) {
      lead = await Lead.findOneAndUpdate(
        upsertFilter,
        {
          $set: leadData,
          $setOnInsert: { date_created: new Date().toISOString() },
        },
        { upsert: true, new: true },
      );
    } else {
      lead = await Lead.create({
        ...leadData,
        date_created: new Date().toISOString(),
      });
    }

    logger.info({ leadId: lead._id, source: "calendly" }, "Lead created/updated from Calendly");

    // Auto-link outbound lead
    lead = await tryLinkOutboundLead(lead, account._id, questionsAndAnswers);

    await syncOutboundLead(lead);
    await callGhlWebhook(account, lead);

    // Auto-create Booking
    await upsertBooking(account, lead, {
      scheduledEventUri, inviteeUri, eventData, email, name,
      utmSource, utmMedium, utmCampaign,
    });

    // Telegram notification (fire-and-forget)
    const outbound = lead.outbound_lead_id
      ? await OutboundLead.findById(lead.outbound_lead_id).lean()
      : null;
    notifyNewLead(account, lead, outbound).catch((err) =>
      logger.error({ err }, "Telegram notify error"),
    );

    return res.json({ success: true, lead });
  } catch (error) {
    logger.error({ err: error }, "Calendly webhook error");
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

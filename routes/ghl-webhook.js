const logger = require("../utils/logger").child({ module: "ghl-webhook" });
const escapeRegex = require("../utils/escapeRegex");
const express = require("express");
const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const Account = require("../models/Account");
const { notifyNewLead } = require("../services/telegramNotifier");
const { emitToAccount } = require("../services/socketManager");

const router = express.Router();

// GHL tag → Lead field mapping (mirrors the n8n Code3 node)
const TAG_MAP = {
  ghosted: "ghosted_at",
  lead_booked: "booked_at",
  booking_link: "booked_at",
  booking_process: "qualified_at",
  follow_up: "follow_up_at",
  followup: "follow_up_at",
  low_ticket: "low_ticket",
  link_sent: "link_sent_at",
};

function normalizeTag(tag) {
  return String(tag).toLowerCase().replace(/\s+/g, "_").replace(/-+/g, "_");
}

/**
 * Try to find a matching OutboundLead for an inbound GHL lead.
 *
 * Uses the same partial regex search as GET /outbound-leads?search=…
 * so that "Romolo Marini" matches "Romolo Marini | Dubai | Immobilienexperte".
 * Matches on fullName or username, plus email as a fallback.
 */
async function findMatchingOutboundLead(accountId, { first_name, last_name, email }) {
  if (!accountId) return null;

  // Resolve the Account's _id (outbound leads use ObjectId, not ghl string)
  const account = await Account.findOne({ ghl: accountId }).lean();
  if (!account) return null;

  const fullName = [first_name, last_name].filter(Boolean).join(" ").trim();

  // Try name-based partial match (same logic as outbound-leads search)
  if (fullName) {
    const byName = await OutboundLead.findOne({
      account_id: account._id,
      $or: [
        { fullName: { $regex: escapeRegex(fullName), $options: "i" } },
        { username: { $regex: escapeRegex(fullName), $options: "i" } },
      ],
    }).lean();
    if (byName) return byName;
  }

  // Fallback: email match
  if (email) {
    const byEmail = await OutboundLead.findOne({
      account_id: account._id,
      email: { $regex: new RegExp(`^${escapeRegex(email.trim())}$`, "i") },
    }).lean();
    if (byEmail) return byEmail;
  }

  return null;
}

// POST /api/ghl/webhook — replaces the n8n "DM tracking sheets" workflow
router.post("/webhook", async (req, res) => {
  try {
    const { first_name, last_name, contact_id, date_created, location, tags, email } = req.body;

    if (!contact_id) {
      return res.status(400).json({ error: "Missing contact_id" });
    }

    const ghlLocationId = location?.id || null;
    if (!ghlLocationId) {
      return res.status(400).json({ error: "Missing location.id" });
    }

    // Resolve GHL location ID → CRM account ObjectId
    const account = await Account.findOne({ ghl: ghlLocationId });
    const accountId = account ? account._id.toString() : ghlLocationId;

    // ---- Find existing lead by contact_id ----
    const existing = await Lead.findOne({ contact_id });

    if (!existing) {
      // ---- New lead: try to cross-reference with outbound leads ----
      const outboundMatch = await findMatchingOutboundLead(ghlLocationId, { first_name, last_name, email });

      const lead = await Lead.create({
        first_name: first_name || null,
        last_name: last_name || null,
        contact_id,
        date_created: date_created || new Date().toISOString(),
        account_id: accountId,
        source: "ghl",
        ...(email && { email }),
        ...(outboundMatch && { outbound_lead_id: outboundMatch._id }),
      });

      if (outboundMatch && account) {
        logger.info(
          { leadId: lead._id, outboundId: outboundMatch._id, username: outboundMatch.username },
          "GHL webhook: inbound lead linked to outbound",
        );

        // Push to extension via WebSocket
        emitToAccount(account._id.toString(), "inbound:conversion", {
          name: [first_name, last_name].filter(Boolean).join(" "),
          outbound_username: outboundMatch.username || null,
          sender_username: null, // resolved async by Telegram notifier
          lead_id: lead._id.toString(),
        });
      }

      logger.info({ leadId: lead._id, contact_id }, "GHL webhook: new lead created");

      // Telegram notification (fire-and-forget)
      if (account) {
        notifyNewLead(account, lead, outboundMatch).catch((err) =>
          logger.error({ err }, "Telegram notify error"),
        );
      }

      return res.json({
        success: true,
        action: "created",
        lead_id: lead._id,
        cross_channel: !!outboundMatch,
      });
    }

    // Fix account_id if it was stored as a GHL location ID
    if (existing.account_id !== accountId) {
      await Lead.findByIdAndUpdate(existing._id, { account_id: accountId });
      existing.account_id = accountId;
    }

    // ---- Existing lead without outbound link: try to cross-reference now ----
    if (!existing.outbound_lead_id) {
      const outboundMatch = await findMatchingOutboundLead(ghlLocationId, {
        first_name: existing.first_name,
        last_name: existing.last_name,
        email: existing.email || email,
      });
      if (outboundMatch) {
        await Lead.findByIdAndUpdate(existing._id, { outbound_lead_id: outboundMatch._id });
        existing.outbound_lead_id = outboundMatch._id;
        logger.info(
          { leadId: existing._id, outboundId: outboundMatch._id },
          "GHL webhook: existing lead linked to outbound",
        );

        // Push to extension via WebSocket
        if (account) {
          emitToAccount(account._id.toString(), "inbound:conversion", {
            name: [existing.first_name, existing.last_name].filter(Boolean).join(" "),
            outbound_username: outboundMatch.username || null,
            sender_username: null,
            lead_id: existing._id.toString(),
          });
        }
      }
    }

    // ---- Existing lead: parse tags and update funnel field ----
    let tagsArr = [];
    if (Array.isArray(tags)) {
      tagsArr = tags;
    } else if (typeof tags === "string") {
      tagsArr = tags.split(",").map((t) => t.trim()).filter(Boolean);
    } else if (tags && typeof tags === "object") {
      tagsArr = Object.values(tags).map((t) => String(t).trim()).filter(Boolean);
    }

    const lastRawTag = tagsArr.length ? tagsArr[tagsArr.length - 1] : null;
    if (!lastRawTag) {
      return res.json({ success: true, action: "no_tags", lead_id: existing._id });
    }

    const lastTag = normalizeTag(lastRawTag);
    const fieldToUpdate = TAG_MAP[lastTag];

    if (!fieldToUpdate) {
      return res.json({ success: true, action: "tag_not_tracked", tag: lastTag, lead_id: existing._id });
    }

    // Only update if field is not already set
    const existingVal = existing[fieldToUpdate];
    if (existingVal) {
      return res.json({ success: true, action: "already_set", field: fieldToUpdate, lead_id: existing._id });
    }

    const today = new Date();
    const updated = await Lead.findByIdAndUpdate(
      existing._id,
      { [fieldToUpdate]: today },
      { new: true },
    );

    logger.info({ leadId: existing._id, field: fieldToUpdate, tag: lastTag }, "GHL webhook: lead updated");

    // Sync to outbound lead if linked
    if (updated.outbound_lead_id) {
      const outboundUpdate = {};
      if (fieldToUpdate === "link_sent_at") {
        outboundUpdate.link_sent = true;
        outboundUpdate.link_sent_at = today;
      }
      if (fieldToUpdate === "booked_at") {
        outboundUpdate.booked = true;
        outboundUpdate.booked_at = today;
      }
      if (Object.keys(outboundUpdate).length > 0) {
        await OutboundLead.findByIdAndUpdate(updated.outbound_lead_id, outboundUpdate);
      }
    }

    // Telegram notification on significant updates (booked, link_sent)
    if (account && (fieldToUpdate === "booked_at" || fieldToUpdate === "link_sent_at")) {
      const outbound = updated.outbound_lead_id
        ? await OutboundLead.findById(updated.outbound_lead_id).lean()
        : null;
      notifyNewLead(account, updated, outbound).catch((err) =>
        logger.error({ err }, "Telegram notify error"),
      );
    }

    return res.json({ success: true, action: "updated", field: fieldToUpdate, lead_id: existing._id });
  } catch (error) {
    logger.error({ err: error }, "GHL webhook error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/ghl/conversation — receives chat_memory from GHL workflow webhook
router.post("/conversation", async (req, res) => {
  try {
    const custom = req.body.customData || {};
    const contact_id = req.body.contact_id || custom.contact_id;
    const conversation = custom.conversation || req.body.chat_memory || req.body.conversation;
    const tags = custom.tags || req.body.tags;
    const { first_name, last_name, email, location } = req.body;

    logger.info({ body: req.body }, "GHL conversation webhook: incoming payload");

    if (!contact_id) {
      return res.status(400).json({ error: "Missing contact_id" });
    }

    const ghlLocationId = location?.id || null;

    // Resolve GHL location ID → CRM account ObjectId
    const account = ghlLocationId ? await Account.findOne({ ghl: ghlLocationId }) : null;
    const accountId = account ? account._id.toString() : ghlLocationId;

    // Build the update payload
    const update = {};
    if (conversation) update.chat_memory = conversation;

    // Find existing lead by contact_id, or create if new
    let lead = await Lead.findOne({ contact_id });

    if (!lead) {
      if (!accountId) {
        return res.status(400).json({ error: "Missing location.id for new lead" });
      }

      const outboundMatch = ghlLocationId
        ? await findMatchingOutboundLead(ghlLocationId, { first_name, last_name, email })
        : null;

      lead = await Lead.create({
        first_name: first_name || null,
        last_name: last_name || null,
        contact_id,
        date_created: new Date().toISOString(),
        account_id: accountId,
        source: "ghl",
        ...(email && { email }),
        ...(outboundMatch && { outbound_lead_id: outboundMatch._id }),
        ...update,
      });

      logger.info({ leadId: lead._id, contact_id }, "GHL conversation webhook: new lead created");
      return res.json({ success: true, action: "created", lead_id: lead._id });
    }

    // Update existing lead with chat_memory
    if (Object.keys(update).length > 0) {
      await Lead.findByIdAndUpdate(lead._id, update);
    }

    logger.info({ leadId: lead._id, contact_id }, "GHL conversation webhook: chat_memory updated");
    return res.json({ success: true, action: "updated", lead_id: lead._id });
  } catch (error) {
    logger.error({ err: error }, "GHL conversation webhook error");
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

const logger = require("../utils/logger").child({ module: "ghl-webhook" });
const express = require("express");
const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const Account = require("../models/Account");
const { notifyNewLead } = require("../services/telegramNotifier");

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

// POST /api/ghl/webhook — replaces the n8n "DM tracking sheets" workflow
router.post("/webhook", async (req, res) => {
  try {
    const { first_name, last_name, contact_id, date_created, location, tags } = req.body;

    if (!contact_id) {
      return res.status(400).json({ error: "Missing contact_id" });
    }

    const accountId = location?.id || null;
    if (!accountId) {
      return res.status(400).json({ error: "Missing location.id" });
    }

    // Resolve the account (needed for Telegram config)
    const account = await Account.findOne({ ghl: accountId });

    // ---- Find existing lead by contact_id ----
    const existing = await Lead.findOne({ contact_id });

    if (!existing) {
      // ---- New lead: insert ----
      const lead = await Lead.create({
        first_name: first_name || null,
        last_name: last_name || null,
        contact_id,
        date_created: date_created || new Date().toISOString(),
        account_id: accountId,
      });

      logger.info({ leadId: lead._id, contact_id }, "GHL webhook: new lead created");

      // Telegram notification (fire-and-forget)
      if (account) {
        notifyNewLead(account, lead, null).catch((err) =>
          logger.error({ err }, "Telegram notify error"),
        );
      }

      return res.json({ success: true, action: "created", lead_id: lead._id });
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

    const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
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

module.exports = router;

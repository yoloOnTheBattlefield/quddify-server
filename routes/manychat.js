const logger = require("../utils/logger").child({ module: "manychat" });
const express = require("express");
const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const { notifyNewLead } = require("../services/telegramNotifier");

const validate = require("../middleware/validate");
const { webhookSchema } = require("../schemas/manychat");

const router = express.Router();

// POST /api/manychat/webhook — ManyChat External Request webhook
router.post("/webhook", validate(webhookSchema), async (req, res) => {
  try {
    const {
      ig_username,
      first_name,
      last_name,
      full_name,
      trigger_type,
      post_url,
    } = req.body;

    if (!ig_username) {
      return res.status(400).json({ error: "Missing ig_username" });
    }

    const username = ig_username.replace(/^@/, "").trim();
    if (!username) {
      return res.status(400).json({ error: "Invalid ig_username" });
    }

    const ghl = req.account.ghl;
    const firstName =
      first_name || (full_name ? full_name.split(" ")[0] : null);
    const lastName =
      last_name ||
      (full_name && full_name.includes(" ")
        ? full_name.split(" ").slice(1).join(" ")
        : null);

    const lead = await Lead.findOneAndUpdate(
      { ig_username: username, account_id: ghl },
      {
        $set: {
          first_name: firstName,
          last_name: lastName,
          source: `manychat:${trigger_type || "unknown"}`,
          ...(post_url ? { post_url: post_url.trim() } : {}),
        },
        $setOnInsert: {
          date_created: new Date().toISOString(),
        },
      },
      { upsert: true, new: true },
    );

    // Cross-reference: link to OutboundLead if this user was previously scraped/messaged
    let crossChannel = false;
    if (!lead.outbound_lead_id) {
      const obLead = await OutboundLead.findOne({
        username,
        account_id: req.account._id,
      }).lean();
      if (obLead) {
        lead.outbound_lead_id = obLead._id;
        await Lead.updateOne(
          { _id: lead._id },
          { $set: { outbound_lead_id: obLead._id } },
        );
        crossChannel = true;
        logger.info(`[manychat] Cross-channel link: ${username} → OutboundLead ${obLead._id}`);
      }
    } else {
      crossChannel = true;
    }

    logger.info(
      `[manychat] Lead upserted: ${username} (trigger: ${trigger_type || "unknown"}, cross: ${crossChannel})`,
    );

    // Telegram notification (fire-and-forget)
    const obLeadForNotify = lead.outbound_lead_id
      ? await OutboundLead.findById(lead.outbound_lead_id).lean()
      : null;
    notifyNewLead(req.account, lead, obLeadForNotify).catch((err) =>
      logger.error({ err }, "Telegram notify error"),
    );

    res.json({
      success: true,
      lead_id: lead._id,
      ig_username: lead.ig_username,
      cross_channel: crossChannel,
    });
  } catch (err) {
    logger.error("[manychat] Webhook error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

const logger = require("../utils/logger").child({ module: "manychat" });
const express = require("express");
const Lead = require("../models/Lead");
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

    // Lead.account_id must be the CRM ObjectId as a string — every read path
    // filters on that.
    const accountId = req.account._id.toString();

    const firstName =
      first_name || (full_name ? full_name.split(" ")[0] : null);
    const lastName =
      last_name ||
      (full_name && full_name.includes(" ")
        ? full_name.split(" ").slice(1).join(" ")
        : null);

    const lead = await Lead.findOneAndUpdate(
      { ig_username: username, account_id: accountId },
      {
        $set: {
          account_id: accountId,
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

    logger.info(
      `[manychat] Lead upserted: ${username} (trigger: ${trigger_type || "unknown"})`,
    );

    // Telegram notification (fire-and-forget)
    notifyNewLead(req.account, lead).catch((err) =>
      logger.error({ err }, "Telegram notify error"),
    );

    res.json({
      success: true,
      lead_id: lead._id,
      ig_username: lead.ig_username,
    });
  } catch (err) {
    logger.error("[manychat] Webhook error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

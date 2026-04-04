const logger = require("../utils/logger").child({ module: "telegram" });
const express = require("express");
const Account = require("../models/Account");
const { encrypt, decrypt } = require("../utils/crypto");

const router = express.Router();

// POST /api/telegram/connect — save bot token + chat ID, send test message
router.post("/connect", async (req, res) => {
  try {
    const bot_token = (req.body.bot_token || "").trim();
    const chat_id = (req.body.chat_id || "").trim();
    if (!bot_token || !chat_id) {
      return res.status(400).json({ error: "bot_token and chat_id are required" });
    }

    // Validate by sending a test message
    const testRes = await fetch(
      `https://api.telegram.org/bot${bot_token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id,
          text: "✅ Quddify CRM connected! You'll receive lead notifications here.",
        }),
      },
    );

    if (!testRes.ok) {
      const err = await testRes.json().catch(() => ({}));
      logger.error({ err, chat_id }, "Telegram test message failed");
      const detail = err.description || "Unknown error";
      return res.status(400).json({
        error: `Telegram API error: ${detail}`,
      });
    }

    await Account.findByIdAndUpdate(req.account._id, {
      telegram_bot_token: encrypt(bot_token),
      telegram_chat_id: chat_id,
    });

    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Telegram connect error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/telegram/test-report — send the daily report now
router.post("/test-report", async (req, res) => {
  try {
    const account = await Account.findById(req.account._id).lean();
    if (!account?.telegram_bot_token || !account?.telegram_chat_id) {
      return res.status(400).json({ error: "Telegram not connected" });
    }

    const { sendReportForAccount } = require("../services/midnightReportScheduler");
    const Campaign = require("../models/Campaign");
    const CampaignLead = require("../models/CampaignLead");
    const OutboundLead = require("../models/OutboundLead");
    const Lead = require("../models/Lead");
    const Booking = require("../models/Booking");

    await sendReportForAccount(account, { Campaign, CampaignLead, OutboundLead, Lead, Booking });

    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Telegram test report error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/telegram/disconnect — remove Telegram config
router.delete("/disconnect", async (req, res) => {
  try {
    await Account.findByIdAndUpdate(req.account._id, {
      telegram_bot_token: null,
      telegram_chat_id: null,
    });
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Telegram disconnect error");
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

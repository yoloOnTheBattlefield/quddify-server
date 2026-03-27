const logger = require("../utils/logger").child({ module: "dm-assistant" });
const express = require("express");
const router = express.Router();

const { analyzeConversation } = require("../services/dmAssistantService");

// POST /api/dm-assistant/analyze
// Receives scraped DM data from the Chrome extension, syncs to DB, returns AI suggestion
router.post("/analyze", async (req, res) => {
  try {
    const { thread_id, messages, prospect, outbound_account_id, sender_id } = req.body;

    if (!thread_id) {
      return res.status(400).json({ error: "thread_id is required" });
    }

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const accountId = req.account._id;

    const result = await analyzeConversation({
      accountId,
      threadId: thread_id,
      messages,
      prospect: prospect || {},
      outboundAccountId: outbound_account_id || req.outboundAccount?._id || null,
    });

    res.json(result);
  } catch (err) {
    logger.error("[dm-assistant] Analyze error:", err);

    if (err.message.includes("No OpenAI token")) {
      return res.status(400).json({ error: "No OpenAI API key configured. Add one in Settings." });
    }

    res.status(500).json({ error: "Failed to analyze conversation" });
  }
});

module.exports = router;

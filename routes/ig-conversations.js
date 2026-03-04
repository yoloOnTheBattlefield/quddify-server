const express = require("express");
const router = express.Router();

const IgConversation = require("../models/IgConversation");
const IgMessage = require("../models/IgMessage");

// GET /api/ig-conversations — list all threads ordered by last_message_at DESC
router.get("/", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [conversations, total] = await Promise.all([
      IgConversation.find()
        .sort({ last_message_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      IgConversation.countDocuments(),
    ]);

    res.json({ conversations, total, page, limit });
  } catch (err) {
    console.error("[ig-conversations] List error:", err);
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

// GET /api/ig-conversations/:id/messages — all messages in a thread ordered by timestamp ASC
router.get("/:id/messages", async (req, res) => {
  try {
    const conversation = await IgConversation.findById(req.params.id).lean();
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const skip = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      IgMessage.find({ conversation_id: conversation._id })
        .sort({ timestamp: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      IgMessage.countDocuments({ conversation_id: conversation._id }),
    ]);

    res.json({ conversation, messages, total, page, limit });
  } catch (err) {
    console.error("[ig-conversations] Messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

module.exports = router;

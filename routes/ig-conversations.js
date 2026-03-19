const logger = require("../utils/logger").child({ module: "ig-conversations" });
const express = require("express");
const router = express.Router();

const IgConversation = require("../models/IgConversation");
const IgMessage = require("../models/IgMessage");
const Lead = require("../models/Lead");

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
    logger.error("[ig-conversations] List error:", err);
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

// GET /api/ig-conversations/by-lead/:leadId — find conversation for a lead using all available identifiers
router.get("/by-lead/:leadId", async (req, res) => {
  try {
    // Look up the lead to get all possible linking fields
    const lead = await Lead.findById(req.params.leadId).lean();

    // Build $or query covering every way a conversation can be linked to this lead
    const orClauses = [{ lead_id: req.params.leadId }];
    if (lead?.ig_thread_id) orClauses.push({ instagram_thread_id: lead.ig_thread_id });
    if (lead?.outbound_lead_id) orClauses.push({ outbound_lead_id: lead.outbound_lead_id });

    let conversation = await IgConversation.findOne({ $or: orClauses }).lean();

    // Fallback: match by ig_username in the participant_usernames map
    if (!conversation && lead?.ig_username) {
      const username = lead.ig_username.replace(/^@/, "").toLowerCase();
      const [match] = await IgConversation.aggregate([
        {
          $addFields: {
            usernameValues: { $map: { input: { $objectToArray: "$participant_usernames" }, as: "kv", in: { $toLower: "$$kv.v" } } },
          },
        },
        { $match: { usernameValues: username } },
        { $limit: 1 },
      ]);
      if (match) conversation = match;
    }

    if (!conversation) {
      // DEBUG: return what we know to diagnose the mismatch
      const allConvs = await IgConversation.find({}).select("_id instagram_thread_id lead_id outbound_lead_id participant_ids participant_usernames").lean();
      return res.status(404).json({
        error: "No conversation found for this lead",
        debug: {
          lead: lead ? { _id: lead._id, ig_username: lead.ig_username, ig_thread_id: lead.ig_thread_id, outbound_lead_id: lead.outbound_lead_id } : null,
          orClauses,
          totalConversations: allConvs.length,
          conversations: allConvs.slice(0, 5),
        },
      });
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
    logger.error("[ig-conversations] By-lead error:", err);
    res.status(500).json({ error: "Failed to fetch conversation" });
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
    logger.error("[ig-conversations] Messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

module.exports = router;

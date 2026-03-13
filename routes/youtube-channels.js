const logger = require("../utils/logger").child({ module: "youtube-channels" });
const express = require("express");
const Channel = require("../models/Channel");

const router = express.Router();

// POST /api/youtube/channels — add a channel to monitor
router.post("/", async (req, res) => {
  try {
    const accountId = req.account._id;
    const { channel_id, channel_url, channel_name } = req.body;

    if (!channel_id && !channel_url) {
      return res.status(400).json({ error: "channel_id or channel_url is required" });
    }

    // Extract channel_id from URL if not provided directly
    let resolvedId = channel_id;
    if (!resolvedId && channel_url) {
      const match = channel_url.match(/\/channel\/([\w-]+)/);
      if (match) {
        resolvedId = match[1];
      } else {
        resolvedId = channel_url.replace(/\/$/, "").split("/").pop();
      }
    }

    const existing = await Channel.findOne({ account_id: accountId, channel_id: resolvedId });
    if (existing) {
      return res.status(409).json({ error: "Channel already monitored", channel: existing });
    }

    const channel = await Channel.create({
      account_id: accountId,
      channel_id: resolvedId,
      channel_url: channel_url || `https://www.youtube.com/channel/${resolvedId}`,
      channel_name: channel_name || null,
    });

    logger.info("Channel added:", resolvedId);
    res.status(201).json(channel);
  } catch (err) {
    logger.error("Add channel error:", err);
    res.status(500).json({ error: "Failed to add channel" });
  }
});

// GET /api/youtube/channels — list monitored channels for current account
router.get("/", async (req, res) => {
  try {
    const accountId = req.account._id;
    const { active } = req.query;
    const filter = { account_id: accountId };
    if (active !== undefined) filter.active = active === "true";

    const channels = await Channel.find(filter).sort({ createdAt: -1 }).lean();
    res.json(channels);
  } catch (err) {
    logger.error("List channels error:", err);
    res.status(500).json({ error: "Failed to list channels" });
  }
});

// DELETE /api/youtube/channels/:id — remove a channel
router.delete("/:id", async (req, res) => {
  try {
    const accountId = req.account._id;
    const channel = await Channel.findOneAndDelete({ account_id: accountId, channel_id: req.params.id });
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }
    logger.info("Channel removed:", req.params.id);
    res.json({ deleted: true, channel });
  } catch (err) {
    logger.error("Delete channel error:", err);
    res.status(500).json({ error: "Failed to delete channel" });
  }
});

module.exports = router;

const logger = require("../utils/logger").child({ module: "youtube-videos" });
const express = require("express");
const Video = require("../models/Video");
const Channel = require("../models/Channel");

const router = express.Router();

// GET /api/youtube/videos — list scraped videos for current account's channels
router.get("/", async (req, res) => {
  try {
    const accountId = req.account._id;

    // Get all channel_ids (both handle-based and UC-based) for this account
    const channels = await Channel.find({ account_id: accountId }).lean();
    const channelIds = channels.map((ch) => ch.channel_id);

    // Also collect any yt_channel_id values mapped from scrapes
    const ytChannelIds = channels
      .filter((ch) => ch.yt_channel_id)
      .map((ch) => ch.yt_channel_id);

    const allIds = [...new Set([...channelIds, ...ytChannelIds])];

    if (allIds.length === 0) {
      return res.json([]);
    }

    const filter = { channel_id: { $in: allIds } };

    const { sort } = req.query;
    let sortOption = { published_at: -1 };
    if (sort === "views") sortOption = { views: -1 };
    if (sort === "velocity") sortOption = { views_per_hour: -1 };

    const videos = await Video.find(filter)
      .sort(sortOption)
      .limit(200)
      .lean();

    res.json(videos);
  } catch (err) {
    logger.error("List videos error:", err);
    res.status(500).json({ error: "Failed to list videos" });
  }
});

module.exports = router;

const logger = require("../utils/logger").child({ module: "youtube-trending" });
const express = require("express");
const TrendingVideo = require("../models/TrendingVideo");

const router = express.Router();

// GET /trending — return latest trending snapshot
router.get("/", async (req, res) => {
  try {
    const { category, country, limit } = req.query;

    // Find the latest batch_id
    const latest = await TrendingVideo.findOne()
      .sort({ scraped_at: -1 })
      .select("batch_id")
      .lean();

    if (!latest) {
      return res.json({ batch_id: null, videos: [] });
    }

    const filter = { batch_id: latest.batch_id };
    if (category) filter.category = category;
    if (country) filter.country = country;

    const pageLimit = Math.min(Number(limit) || 50, 200);

    const videos = await TrendingVideo.find(filter)
      .sort({ views: -1 })
      .limit(pageLimit)
      .lean();

    res.json({ batch_id: latest.batch_id, videos });
  } catch (err) {
    logger.error("List trending error:", err);
    res.status(500).json({ error: "Failed to list trending videos" });
  }
});

module.exports = router;

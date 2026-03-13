const logger = require("../utils/logger").child({ module: "youtube-alerts" });
const express = require("express");
const TrendAlert = require("../models/TrendAlert");

const router = express.Router();

// GET /alerts — return current breakout alerts sorted by velocity desc
router.get("/", async (req, res) => {
  try {
    const { active, limit } = req.query;
    const filter = {};
    if (active !== undefined) filter.active = active === "true";

    const pageLimit = Math.min(Number(limit) || 50, 200);

    const alerts = await TrendAlert.find(filter)
      .sort({ views_per_hour: -1 })
      .limit(pageLimit)
      .lean();

    res.json(alerts);
  } catch (err) {
    logger.error("List alerts error:", err);
    res.status(500).json({ error: "Failed to list alerts" });
  }
});

module.exports = router;

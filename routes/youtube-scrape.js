const logger = require("../utils/logger").child({ module: "youtube-scrape" });
const express = require("express");
const scrapeService = require("../services/scrapeService");

const router = express.Router();

// POST /api/youtube/scrape/run — manually trigger a scrape cycle
router.post("/run", async (req, res) => {
  try {
    const accountId = req.account._id;
    logger.info("Manual scrape pipeline triggered for account:", accountId.toString());
    const result = await scrapeService.runFullPipeline(accountId);
    res.json({ status: "completed", result });
  } catch (err) {
    logger.error("Manual scrape error:", err);
    res.status(500).json({ error: err.message || "Scrape pipeline failed" });
  }
});

module.exports = router;

const express = require("express");
const router = express.Router();
const ThumbnailJob = require("../models/ThumbnailJob");
const ClientImage = require("../models/ClientImage");
const logger = require("../utils/logger").child({ module: "thumbnails" });

// GET /api/thumbnails?client_id=xxx
router.get("/", async (req, res) => {
  try {
    const filter = { account_id: req.account._id };
    if (req.query.client_id) filter.client_id = req.query.client_id;
    const jobs = await ThumbnailJob.find(filter).sort({ created_at: -1 }).limit(50);
    res.json(jobs);
  } catch (err) {
    logger.error("Failed to list thumbnail jobs:", err);
    res.status(500).json({ error: "Failed to list thumbnail jobs" });
  }
});

// GET /api/thumbnails/jobs/:jobId
router.get("/jobs/:jobId", async (req, res) => {
  try {
    const job = await ThumbnailJob.findOne({ _id: req.params.jobId, account_id: req.account._id });
    if (!job) return res.status(404).json({ error: "Thumbnail job not found" });
    res.json(job);
  } catch (err) {
    logger.error("Failed to get thumbnail job:", err);
    res.status(500).json({ error: "Failed to get thumbnail job" });
  }
});

// POST /api/thumbnails/generate
router.post("/generate", async (req, res) => {
  try {
    const { client_id, topic, headshot_image_id, reference_urls, template_id } = req.body;

    if (!client_id || !topic || !headshot_image_id) {
      return res.status(400).json({ error: "client_id, topic, and headshot_image_id are required" });
    }

    // Verify headshot exists and belongs to this account
    const headshot = await ClientImage.findOne({
      _id: headshot_image_id,
      account_id: req.account._id,
      client_id,
    });
    if (!headshot) return res.status(404).json({ error: "Headshot image not found" });

    // Validate reference URLs (max 5)
    const validUrls = (reference_urls || [])
      .filter((u) => typeof u === "string" && u.startsWith("http"))
      .slice(0, 5);

    const job = await ThumbnailJob.create({
      client_id,
      account_id: req.account._id,
      topic,
      headshot_image_id,
      template_id: template_id || null,
      reference_urls: validUrls,
      status: "queued",
    });

    // Run pipeline in background
    const { runThumbnailPipeline } = require("../services/thumbnailService");
    runThumbnailPipeline({
      jobId: job._id.toString(),
      io: req.app.get("io"),
    }).catch((err) => {
      logger.error("Background thumbnail pipeline failed:", err);
    });

    res.status(201).json(job);
  } catch (err) {
    logger.error("Failed to start thumbnail generation:", err);
    res.status(500).json({ error: "Failed to start thumbnail generation" });
  }
});

// POST /api/thumbnails/:jobId/iterate
router.post("/:jobId/iterate", async (req, res) => {
  try {
    const { label, feedback } = req.body;

    if (!label || !feedback) {
      return res.status(400).json({ error: "label and feedback are required" });
    }

    const job = await ThumbnailJob.findOne({ _id: req.params.jobId, account_id: req.account._id });
    if (!job) return res.status(404).json({ error: "Thumbnail job not found" });
    if (job.status !== "completed") return res.status(400).json({ error: "Job must be completed before iterating" });

    const { iterateThumbnail } = require("../services/thumbnailService");
    const result = await iterateThumbnail({
      jobId: job._id.toString(),
      label,
      feedback,
      io: req.app.get("io"),
    });

    res.json(result);
  } catch (err) {
    logger.error("Failed to iterate thumbnail:", err);
    res.status(500).json({ error: "Failed to iterate thumbnail" });
  }
});

module.exports = router;

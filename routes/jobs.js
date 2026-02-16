const express = require("express");
const multer = require("multer");
const QualificationJob = require("../models/QualificationJob");
const Prompt = require("../models/Prompt");
const { storeBuffers } = require("../utils/fileStore");
const jobQueue = require("../services/jobQueue");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /jobs — create a new qualification job
router.post("/", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const { promptId } = req.body;
    const account_id = req.account._id;

    // Parse column mapping if provided
    let columnMapping = null;
    if (req.body.columnMapping) {
      try {
        columnMapping = JSON.parse(req.body.columnMapping);
      } catch (e) {
        return res.status(400).json({ error: "Invalid columnMapping JSON" });
      }
    }

    // Resolve prompt label for display
    let promptLabel = null;
    if (promptId) {
      const prompt = await Prompt.findById(promptId).lean();
      if (!prompt) {
        return res.status(400).json({ error: `Prompt not found: ${promptId}` });
      }
      promptLabel = prompt.label;
    }

    // Build file entries
    const fileEntries = req.files.map((f) => ({
      filename: f.originalname,
      status: "queued",
    }));

    // Create job document
    const job = await QualificationJob.create({
      account_id,
      status: "queued",
      promptId: promptId || null,
      promptLabel: promptLabel || "Default (hardcoded)",
      files: fileEntries,
      columnMapping,
    });

    // Store file buffers in memory for the worker
    const buffers = req.files.map((f) => ({
      filename: f.originalname,
      buffer: f.buffer,
    }));
    storeBuffers(job._id.toString(), buffers);

    // Enqueue job
    jobQueue.enqueue(job._id.toString());

    res.status(201).json({
      jobId: job._id,
      status: "queued",
    });
  } catch (err) {
    console.error("Job creation error:", err);
    res.status(500).json({ error: "Failed to create job" });
  }
});

// GET /jobs — list recent jobs for an account
router.get("/", async (req, res) => {
  try {
    const { page, limit } = req.query;
    const account_id = req.account._id;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const [jobs, total] = await Promise.all([
      QualificationJob.find({ account_id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      QualificationJob.countDocuments({ account_id }),
    ]);

    res.json({
      jobs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("List jobs error:", err);
    res.status(500).json({ error: "Failed to list jobs" });
  }
});

// GET /jobs/:id — full job details
router.get("/:id", async (req, res) => {
  try {
    const job = await QualificationJob.findById(req.params.id).lean();
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    console.error("Get job error:", err);
    res.status(500).json({ error: "Failed to get job" });
  }
});

// POST /jobs/:id/cancel — request cancellation
router.post("/:id/cancel", async (req, res) => {
  try {
    const job = await QualificationJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    if (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return res
        .status(400)
        .json({ error: `Cannot cancel job with status: ${job.status}` });
    }

    job.cancelRequested = true;
    await job.save();

    res.json({ jobId: job._id, cancelRequested: true });
  } catch (err) {
    console.error("Cancel job error:", err);
    res.status(500).json({ error: "Failed to cancel job" });
  }
});

module.exports = router;

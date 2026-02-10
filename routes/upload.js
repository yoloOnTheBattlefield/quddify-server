const express = require("express");
const multer = require("multer");
const QualificationJob = require("../models/QualificationJob");
const Prompt = require("../models/Prompt");
const { storeBuffers } = require("../utils/fileStore");
const jobQueue = require("../services/jobQueue");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/upload-xlsx — now creates a background job
router.post("/upload-xlsx", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const { promptId, account_id } = req.body;

    if (!account_id) {
      return res.status(400).json({ error: "account_id is required" });
    }

    let promptLabel = null;
    if (promptId) {
      const prompt = await Prompt.findById(promptId).lean();
      if (!prompt) {
        return res.status(400).json({ error: `Prompt not found: ${promptId}` });
      }
      promptLabel = prompt.label;
    }

    const fileEntries = req.files.map((f) => ({
      filename: f.originalname,
      status: "queued",
    }));

    const job = await QualificationJob.create({
      account_id,
      status: "queued",
      promptId: promptId || null,
      promptLabel: promptLabel || "Default (hardcoded)",
      files: fileEntries,
    });

    const buffers = req.files.map((f) => ({
      filename: f.originalname,
      buffer: f.buffer,
    }));
    storeBuffers(job._id.toString(), buffers);
    jobQueue.enqueue(job._id.toString());

    res.status(202).json({ jobId: job._id, status: "queued" });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

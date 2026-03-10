const express = require("express");
const router = express.Router();
const Transcript = require("../models/Transcript");
const validate = require("../middleware/validate");
const transcriptSchemas = require("../schemas/transcripts");
const logger = require("../utils/logger").child({ module: "transcripts" });

// GET /api/transcripts?client_id=xxx
router.get("/", async (req, res) => {
  try {
    const filter = { account_id: req.account._id };
    if (req.query.client_id) filter.client_id = req.query.client_id;
    if (req.query.status) filter.status = req.query.status;
    const transcripts = await Transcript.find(filter).sort({ created_at: -1 });
    res.json(transcripts);
  } catch (err) {
    logger.error("Failed to list transcripts:", err);
    res.status(500).json({ error: "Failed to list transcripts" });
  }
});

// GET /api/transcripts/:id
router.get("/:id", async (req, res) => {
  try {
    const transcript = await Transcript.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!transcript) return res.status(404).json({ error: "Transcript not found" });
    res.json(transcript);
  } catch (err) {
    logger.error("Failed to get transcript:", err);
    res.status(500).json({ error: "Failed to get transcript" });
  }
});

// POST /api/transcripts
router.post("/", validate(transcriptSchemas.create), async (req, res) => {
  try {
    const transcript = await Transcript.create({ ...req.body, account_id: req.account._id, status: "pending" });
    // Analyze in background — don't block the response
    const { analyzeTranscript } = require("../services/carousel/transcriptAnalyzer");
    analyzeTranscript(transcript._id.toString(), req.body.ai_model).catch((err) => {
      logger.error("Background transcript analysis failed:", err);
    });
    res.status(201).json(transcript);
  } catch (err) {
    logger.error("Failed to create transcript:", err);
    res.status(500).json({ error: "Failed to create transcript" });
  }
});

// POST /api/transcripts/:id/reanalyze — re-run analysis with a different model
router.post("/:id/reanalyze", async (req, res) => {
  try {
    const transcript = await Transcript.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!transcript) return res.status(404).json({ error: "Transcript not found" });
    const model = req.body.ai_model || transcript.ai_model || "gpt-4o";
    await Transcript.findByIdAndUpdate(req.params.id, { status: "pending", ai_model: model });
    const { analyzeTranscript } = require("../services/carousel/transcriptAnalyzer");
    analyzeTranscript(req.params.id, model).catch((err) => {
      logger.error("Background re-analysis failed:", err);
    });
    res.json({ success: true, model });
  } catch (err) {
    logger.error("Failed to reanalyze transcript:", err);
    res.status(500).json({ error: "Failed to reanalyze transcript" });
  }
});

// DELETE /api/transcripts/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await Transcript.findOneAndDelete({ _id: req.params.id, account_id: req.account._id });
    if (!result) return res.status(404).json({ error: "Transcript not found" });
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete transcript:", err);
    res.status(500).json({ error: "Failed to delete transcript" });
  }
});

module.exports = router;

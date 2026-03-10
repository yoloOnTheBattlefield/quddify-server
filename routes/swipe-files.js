const express = require("express");
const router = express.Router();
const SwipeFile = require("../models/SwipeFile");
const validate = require("../middleware/validate");
const swipeFileSchemas = require("../schemas/swipe-files");
const logger = require("../utils/logger").child({ module: "swipe-files" });

// GET /api/swipe-files?client_id=xxx
router.get("/", async (req, res) => {
  try {
    const filter = { account_id: req.account._id };
    if (req.query.client_id) filter.client_id = req.query.client_id;
    const files = await SwipeFile.find(filter).sort({ created_at: -1 });
    res.json(files);
  } catch (err) {
    logger.error("Failed to list swipe files:", err);
    res.status(500).json({ error: "Failed to list swipe files" });
  }
});

// GET /api/swipe-files/:id
router.get("/:id", async (req, res) => {
  try {
    const file = await SwipeFile.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!file) return res.status(404).json({ error: "Swipe file not found" });
    res.json(file);
  } catch (err) {
    logger.error("Failed to get swipe file:", err);
    res.status(500).json({ error: "Failed to get swipe file" });
  }
});

// POST /api/swipe-files
router.post("/", validate(swipeFileSchemas.create), async (req, res) => {
  try {
    const file = await SwipeFile.create({ ...req.body, account_id: req.account._id, status: "pending" });
    // TODO: Queue style analysis job here
    res.status(201).json(file);
  } catch (err) {
    logger.error("Failed to create swipe file:", err);
    res.status(500).json({ error: "Failed to create swipe file" });
  }
});

// DELETE /api/swipe-files/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await SwipeFile.findOneAndDelete({ _id: req.params.id, account_id: req.account._id });
    if (!result) return res.status(404).json({ error: "Swipe file not found" });
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete swipe file:", err);
    res.status(500).json({ error: "Failed to delete swipe file" });
  }
});

module.exports = router;

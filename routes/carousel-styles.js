const express = require("express");
const router = express.Router();
const CarouselStyle = require("../models/CarouselStyle");
const logger = require("../utils/logger").child({ module: "carousel-styles" });

// GET /api/carousel-styles
router.get("/", async (req, res) => {
  try {
    const styles = await CarouselStyle.find({ account_id: req.account._id }).sort({ created_at: -1 });
    res.json(styles);
  } catch (err) {
    logger.error("Failed to list styles:", err);
    res.status(500).json({ error: "Failed to list styles" });
  }
});

// GET /api/carousel-styles/:id
router.get("/:id", async (req, res) => {
  try {
    const style = await CarouselStyle.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!style) return res.status(404).json({ error: "Style not found" });
    res.json(style);
  } catch (err) {
    logger.error("Failed to get style:", err);
    res.status(500).json({ error: "Failed to get style" });
  }
});

// POST /api/carousel-styles
router.post("/", async (req, res) => {
  try {
    const { name, style_prompt } = req.body;
    if (!name || !style_prompt) return res.status(400).json({ error: "name and style_prompt are required" });

    const style = await CarouselStyle.create({
      account_id: req.account._id,
      name,
      style_prompt,
    });
    res.status(201).json(style);
  } catch (err) {
    logger.error("Failed to create style:", err);
    res.status(500).json({ error: "Failed to create style" });
  }
});

// PATCH /api/carousel-styles/:id
router.patch("/:id", async (req, res) => {
  try {
    const style = await CarouselStyle.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: req.body },
      { new: true },
    );
    if (!style) return res.status(404).json({ error: "Style not found" });
    res.json(style);
  } catch (err) {
    logger.error("Failed to update style:", err);
    res.status(500).json({ error: "Failed to update style" });
  }
});

// DELETE /api/carousel-styles/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await CarouselStyle.findOneAndDelete({ _id: req.params.id, account_id: req.account._id });
    if (!result) return res.status(404).json({ error: "Style not found" });
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete style:", err);
    res.status(500).json({ error: "Failed to delete style" });
  }
});

module.exports = router;

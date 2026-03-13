const express = require("express");
const router = express.Router();
const CarouselTemplate = require("../models/CarouselTemplate");
const logger = require("../utils/logger").child({ module: "carousel-templates" });

// GET /api/carousel-templates?type=content_structure
router.get("/", async (req, res) => {
  try {
    const filter = { account_id: req.account._id };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.client_id) {
      filter.$or = [{ client_id: req.query.client_id }, { client_id: null }];
    }
    const templates = await CarouselTemplate.find(filter).sort({ created_at: -1 });
    res.json(templates);
  } catch (err) {
    logger.error("Failed to list templates:", err);
    res.status(500).json({ error: "Failed to list templates" });
  }
});

// GET /api/carousel-templates/:id
router.get("/:id", async (req, res) => {
  try {
    const template = await CarouselTemplate.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!template) return res.status(404).json({ error: "Template not found" });
    res.json(template);
  } catch (err) {
    logger.error("Failed to get template:", err);
    res.status(500).json({ error: "Failed to get template" });
  }
});

// POST /api/carousel-templates
router.post("/", async (req, res) => {
  try {
    const template = await CarouselTemplate.create({ ...req.body, account_id: req.account._id });
    res.status(201).json(template);
  } catch (err) {
    logger.error("Failed to create template:", err);
    res.status(500).json({ error: "Failed to create template" });
  }
});

// PATCH /api/carousel-templates/:id
router.patch("/:id", async (req, res) => {
  try {
    const template = await CarouselTemplate.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: req.body },
      { new: true },
    );
    if (!template) return res.status(404).json({ error: "Template not found" });
    res.json(template);
  } catch (err) {
    logger.error("Failed to update template:", err);
    res.status(500).json({ error: "Failed to update template" });
  }
});

// POST /api/carousel-templates/:id/clone — duplicate a template, optionally for a different client
router.post("/:id/clone", async (req, res) => {
  try {
    const original = await CarouselTemplate.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!original) return res.status(404).json({ error: "Template not found" });

    const obj = original.toObject();
    delete obj._id;
    delete obj.created_at;
    delete obj.updated_at;

    const clone = await CarouselTemplate.create({
      ...obj,
      account_id: req.account._id,
      client_id: req.body.client_id || null,
      name: req.body.name || `${original.name} (Copy)`,
      source_swipe_file_id: null,
      is_default: false,
    });
    res.status(201).json(clone);
  } catch (err) {
    logger.error("Failed to clone template:", err);
    res.status(500).json({ error: "Failed to clone template" });
  }
});

// DELETE /api/carousel-templates/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await CarouselTemplate.findOneAndDelete({ _id: req.params.id, account_id: req.account._id });
    if (!result) return res.status(404).json({ error: "Template not found" });
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete template:", err);
    res.status(500).json({ error: "Failed to delete template" });
  }
});

module.exports = router;

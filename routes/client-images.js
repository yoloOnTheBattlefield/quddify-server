const express = require("express");
const router = express.Router();
const ClientImage = require("../models/ClientImage");
const { TAG_VOCABULARY } = require("../services/carousel/tagVocabulary");
const logger = require("../utils/logger").child({ module: "client-images" });

// GET /api/client-images/tags — return available tag vocabulary
router.get("/tags", async (_req, res) => {
  res.json(TAG_VOCABULARY);
});

// GET /api/client-images?client_id=xxx&emotion=confident&context=gym&page=1&limit=50
router.get("/", async (req, res) => {
  try {
    const { client_id, emotion, context, vibe, activity, body_language, clothing, setting, lighting, facial_expression, status, suitable_as_cover, min_quality, page = 1, limit = 50 } = req.query;
    const filter = { account_id: req.account._id };
    if (client_id) filter.client_id = client_id;
    if (status) filter.status = status;
    else filter.status = "ready";
    if (emotion) filter["tags.emotion"] = emotion;
    if (context) filter["tags.context"] = context;
    if (vibe) filter["tags.vibe"] = vibe;
    if (activity) filter["tags.activity"] = activity;
    if (body_language) filter["tags.body_language"] = body_language;
    if (clothing) filter["tags.clothing"] = clothing;
    if (setting) filter["tags.setting"] = setting;
    if (lighting) filter["tags.lighting"] = lighting;
    if (facial_expression) filter["tags.facial_expression"] = facial_expression;
    if (suitable_as_cover === "true") filter.suitable_as_cover = true;
    if (min_quality) filter.quality_score = { $gte: Number(min_quality) };

    const skip = (Number(page) - 1) * Number(limit);
    const [images, total] = await Promise.all([
      ClientImage.find(filter).sort({ created_at: -1 }).skip(skip).limit(Number(limit)),
      ClientImage.countDocuments(filter),
    ]);
    res.json({ images, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    logger.error("Failed to list images:", err);
    res.status(500).json({ error: "Failed to list images" });
  }
});

// GET /api/client-images/:id
router.get("/:id", async (req, res) => {
  try {
    const image = await ClientImage.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!image) return res.status(404).json({ error: "Image not found" });
    res.json(image);
  } catch (err) {
    logger.error("Failed to get image:", err);
    res.status(500).json({ error: "Failed to get image" });
  }
});

// PATCH /api/client-images/:id — update tags, status, etc.
router.patch("/:id", async (req, res) => {
  try {
    const image = await ClientImage.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: req.body },
      { new: true },
    );
    if (!image) return res.status(404).json({ error: "Image not found" });
    res.json(image);
  } catch (err) {
    logger.error("Failed to update image:", err);
    res.status(500).json({ error: "Failed to update image" });
  }
});

// DELETE /api/client-images/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await ClientImage.findOneAndDelete({ _id: req.params.id, account_id: req.account._id });
    if (!result) return res.status(404).json({ error: "Image not found" });
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete image:", err);
    res.status(500).json({ error: "Failed to delete image" });
  }
});

module.exports = router;

const express = require("express");
const router = express.Router();
const ClientImage = require("../models/ClientImage");
const { TAG_VOCABULARY } = require("../services/carousel/tagVocabulary");
const { getPresignedUrl } = require("../services/storageService");
const logger = require("../utils/logger").child({ module: "client-images" });
const { buildClientScopedFilter, getOwnedClientIds, findOwnedDoc } = require("../utils/clientUserScope");

// GET /api/client-images/tags — return available tag vocabulary
router.get("/tags", async (_req, res) => {
  res.json(TAG_VOCABULARY);
});

// GET /api/client-images?client_id=xxx&emotion=confident&context=gym&page=1&limit=50
router.get("/", async (req, res) => {
  try {
    const { client_id, emotion, context, vibe, activity, body_language, clothing, setting, lighting, facial_expression, status, suitable_as_cover, min_quality, page = 1, limit = 50 } = req.query;
    // role=2 users have data under the creator's account_id, not their own.
    // Scope by client_id (their owned Clients) instead of account_id.
    const baseFilter = await buildClientScopedFilter(req);
    if (baseFilter === null) return res.json({ images: [], total: 0, page: Number(page), limit: Number(limit) });
    const filter = { ...baseFilter, source: { $ne: "prospect_scrape" } };
    if (client_id) filter.client_id = client_id;
    if (status) filter.status = status;
    else filter.status = { $in: ["ready", "processing", "failed"] };
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
      ClientImage.find(filter).sort({ created_at: -1 }).skip(skip).limit(Number(limit)).lean(),
      ClientImage.countDocuments(filter),
    ]);

    // Attach presigned thumbnail URLs
    const imagesWithUrls = await Promise.all(
      images.map(async (img) => {
        const key = img.thumbnail_key || img.storage_key;
        const thumbnail_url = await getPresignedUrl(key, 3600);
        return { ...img, thumbnail_url };
      }),
    );

    res.json({ images: imagesWithUrls, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    logger.error("Failed to list images:", err);
    res.status(500).json({ error: "Failed to list images" });
  }
});

// GET /api/client-images/:id
router.get("/:id", async (req, res) => {
  try {
    const image = await findOwnedDoc(ClientImage, req, req.params.id);
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
    const existing = await findOwnedDoc(ClientImage, req, req.params.id);
    if (!existing) return res.status(404).json({ error: "Image not found" });
    const image = await ClientImage.findByIdAndUpdate(existing._id, { $set: req.body }, { new: true });
    res.json(image);
  } catch (err) {
    logger.error("Failed to update image:", err);
    res.status(500).json({ error: "Failed to update image" });
  }
});

// DELETE /api/client-images/:id
router.delete("/:id", async (req, res) => {
  try {
    const existing = await findOwnedDoc(ClientImage, req, req.params.id);
    if (!existing) return res.status(404).json({ error: "Image not found" });
    const image = await ClientImage.findByIdAndDelete(existing._id);
    // Clean up S3 files in background
    const { remove } = require("../services/storageService");
    Promise.all([
      remove(image.storage_key).catch(() => {}),
      image.thumbnail_key ? remove(image.thumbnail_key).catch(() => {}) : Promise.resolve(),
    ]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete image:", err);
    res.status(500).json({ error: "Failed to delete image" });
  }
});

// POST /api/client-images/bulk-delete
// Body: { image_ids: string[] }
router.post("/bulk-delete", async (req, res) => {
  try {
    const { image_ids } = req.body;
    if (!image_ids || !Array.isArray(image_ids) || image_ids.length === 0) {
      return res.status(400).json({ error: "image_ids array is required" });
    }

    const ownedClientIds = await getOwnedClientIds(req);
    if (ownedClientIds.length === 0) return res.json({ deleted: 0 });
    const images = await ClientImage.find({
      _id: { $in: image_ids },
      client_id: { $in: ownedClientIds },
    });
    if (images.length === 0) return res.json({ deleted: 0 });

    await ClientImage.deleteMany({ _id: { $in: images.map((i) => i._id) } });

    // Clean up S3 files in background
    const { remove } = require("../services/storageService");
    Promise.allSettled(
      images.flatMap((img) => [
        remove(img.storage_key).catch(() => {}),
        img.thumbnail_key ? remove(img.thumbnail_key).catch(() => {}) : Promise.resolve(),
      ]),
    ).catch(() => {});

    res.json({ deleted: images.length });
  } catch (err) {
    logger.error("Failed to bulk delete images:", err);
    res.status(500).json({ error: "Failed to bulk delete images" });
  }
});

// GET /api/client-images/:id/file?type=thumbnail|original
// Returns a redirect to a presigned S3 URL
router.get("/:id/file", async (req, res) => {
  try {
    const image = await findOwnedDoc(ClientImage, req, req.params.id);
    if (!image) return res.status(404).json({ error: "Image not found" });

    const key = req.query.type === "original" ? image.storage_key : (image.thumbnail_key || image.storage_key);
    const url = await getPresignedUrl(key, 3600);
    res.redirect(url);
  } catch (err) {
    logger.error("Failed to serve image file:", err);
    res.status(500).json({ error: "Failed to serve image" });
  }
});

module.exports = router;

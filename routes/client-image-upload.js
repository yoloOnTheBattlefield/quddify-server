const express = require("express");
const router = express.Router();
const multer = require("multer");
const sharp = require("sharp");
const mongoose = require("mongoose");
const { upload: s3Upload } = require("../services/storageService");
const ClientImage = require("../models/ClientImage");
const logger = require("../utils/logger").child({ module: "client-image-upload" });
const { loadOwnedClient, getOwnedClientIds } = require("../utils/clientUserScope");

// Use memory storage - files stay in buffer
const storage = multer.memoryStorage();
const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  },
});

// POST /api/client-images/upload
// Form data: client_id (string), images (file[])
router.post("/upload", uploadMiddleware.array("images", 10), async (req, res) => {
  try {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: "client_id is required" });

    const client = await loadOwnedClient(req, client_id);
    if (!client) return res.status(404).json({ error: "Client not found" });
    // Use the client's owning account_id for storage paths and the DB record,
    // not req.account._id (which for role=2 is the user's empty isolated account).
    const accountId = client.account_id;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    // Process all files in parallel
    const results = await Promise.allSettled(req.files.map(async (file) => {
      const metadata = await sharp(file.buffer).metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;

      // Generate thumbnail
      const thumbnailBuffer = await sharp(file.buffer)
        .resize(400, null, { withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      const imageId = new mongoose.Types.ObjectId();
      const ext = file.mimetype === "image/png" ? "png" : "jpg";
      const originalKey = `${accountId}/${client_id}/images/originals/${imageId}.${ext}`;
      const thumbnailKey = `${accountId}/${client_id}/images/thumbnails/${imageId}.webp`;

      // Upload original and thumbnail to S3 in parallel
      await Promise.all([
        s3Upload(originalKey, file.buffer, file.mimetype),
        s3Upload(thumbnailKey, thumbnailBuffer, "image/webp"),
      ]);

      // Create DB record
      const image = await ClientImage.create({
        _id: imageId,
        client_id,
        account_id: accountId,
        storage_key: originalKey,
        thumbnail_key: thumbnailKey,
        original_filename: file.originalname,
        mime_type: file.mimetype,
        width,
        height,
        file_size: file.size,
        aspect_ratio: width && height ? width / height : 1,
        is_portrait: height > width,
        status: "processing",
        source: "manual_upload",
        total_uses: 0,
        used_in_carousels: [],
      });

      return image;
    }));

    const created = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled") {
        created.push(results[i].value);
      } else {
        logger.error(`Failed to process upload ${req.files[i].originalname}:`, results[i].reason);
      }
    }

    // Queue tagging for all uploaded images
    if (created.length > 0) {
      const { tagImageBatch } = require("../services/carousel/imageTagging");
      const imageIds = created.map((img) => img._id.toString());
      // Run in background - don't await
      tagImageBatch(imageIds, 3).catch((err) => {
        logger.error("Batch tagging after upload failed:", err);
      });
    }

    res.status(201).json({
      uploaded: created.length,
      failed: req.files.length - created.length,
      image_ids: created.map((img) => img._id.toString()),
      images: created,
    });
  } catch (err) {
    logger.error({ err, stack: err.stack }, "Upload failed:");
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// POST /api/client-images/retag
// Body: { client_id } — re-tags all ready/failed images for this client
router.post("/retag", async (req, res) => {
  try {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: "client_id is required" });

    const client = await loadOwnedClient(req, client_id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const images = await ClientImage.find({
      client_id,
      status: { $in: ["ready", "failed"] },
    });

    if (images.length === 0) {
      return res.json({ queued: 0, message: "No images to re-tag" });
    }

    // Reset status to processing
    await ClientImage.updateMany(
      { _id: { $in: images.map((i) => i._id) } },
      { $set: { status: "processing" } },
    );

    const { tagImageBatch } = require("../services/carousel/imageTagging");
    const imageIds = images.map((img) => img._id.toString());

    // Run in background
    tagImageBatch(imageIds, 3).catch((err) => {
      logger.error("Batch re-tagging failed:", err);
    });

    res.json({ queued: images.length });
  } catch (err) {
    logger.error("Re-tag failed:", err);
    res.status(500).json({ error: "Re-tag failed" });
  }
});

// POST /api/client-images/retry-tag
// Body: { image_ids: string[] } — retry tagging for specific failed images
router.post("/retry-tag", async (req, res) => {
  try {
    const { image_ids } = req.body;
    if (!image_ids || !Array.isArray(image_ids) || image_ids.length === 0) {
      return res.status(400).json({ error: "image_ids array is required" });
    }

    const ownedClientIds = await getOwnedClientIds(req);
    if (ownedClientIds.length === 0) {
      return res.json({ queued: 0, message: "No failed images to retry" });
    }
    const images = await ClientImage.find({
      _id: { $in: image_ids },
      client_id: { $in: ownedClientIds },
      status: "failed",
    });

    if (images.length === 0) {
      return res.json({ queued: 0, message: "No failed images to retry" });
    }

    await ClientImage.updateMany(
      { _id: { $in: images.map((i) => i._id) } },
      { $set: { status: "processing" } },
    );

    const { tagImageBatch } = require("../services/carousel/imageTagging");
    const imageIds = images.map((img) => img._id.toString());

    tagImageBatch(imageIds, 3).catch((err) => {
      logger.error("Retry tagging failed:", err);
    });

    res.json({ queued: images.length });
  } catch (err) {
    logger.error("Retry tag failed:", err);
    res.status(500).json({ error: "Retry tag failed" });
  }
});

module.exports = router;

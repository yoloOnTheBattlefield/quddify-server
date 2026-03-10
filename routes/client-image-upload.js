const express = require("express");
const router = express.Router();
const multer = require("multer");
const sharp = require("sharp");
const mongoose = require("mongoose");
const { upload: s3Upload } = require("../services/storageService");
const ClientImage = require("../models/ClientImage");
const Client = require("../models/Client");
const logger = require("../utils/logger").child({ module: "client-image-upload" });

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
router.post("/upload", uploadMiddleware.array("images", 20), async (req, res) => {
  try {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: "client_id is required" });

    const client = await Client.findOne({ _id: client_id, account_id: req.account._id });
    if (!client) return res.status(404).json({ error: "Client not found" });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const created = [];

    for (const file of req.files) {
      try {
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
        const originalKey = `${req.account._id}/${client_id}/images/originals/${imageId}.${ext}`;
        const thumbnailKey = `${req.account._id}/${client_id}/images/thumbnails/${imageId}.webp`;

        // Upload to S3
        await s3Upload(originalKey, file.buffer, file.mimetype);
        await s3Upload(thumbnailKey, thumbnailBuffer, "image/webp");

        // Create DB record
        const image = await ClientImage.create({
          _id: imageId,
          client_id,
          account_id: req.account._id,
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

        created.push(image);
      } catch (err) {
        logger.error(`Failed to process upload ${file.originalname}:`, err);
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
      images: created,
    });
  } catch (err) {
    logger.error("Upload failed:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// POST /api/client-images/retag
// Body: { client_id } — re-tags all ready/failed images for this client
router.post("/retag", async (req, res) => {
  try {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: "client_id is required" });

    const images = await ClientImage.find({
      client_id,
      account_id: req.account._id,
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

module.exports = router;

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const logger = require("../utils/logger").child({ module: "reels" });
const storage = require("../services/storageService");
const { generateReels, probeVideo } = require("../services/reelGenerator");

const router = express.Router();

// Accept video uploads up to 100 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/")) return cb(null, true);
    cb(new Error("Only video files are allowed"));
  },
});

/**
 * POST /api/reels/generate
 * Body (multipart):
 *   - video: file
 *   - captions: JSON string array
 *   - fontSize (optional): number
 *   - textX (optional): 0-100 percentage for horizontal position
 *   - textY (optional): 0-100 percentage for vertical position
 *   - maxDuration (optional): seconds
 */
router.post("/generate", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No video file provided" });
    }

    let captions;
    try {
      captions = JSON.parse(req.body.captions || "[]");
    } catch {
      return res.status(400).json({ error: "captions must be a valid JSON array" });
    }

    if (!Array.isArray(captions) || captions.length === 0) {
      return res.status(400).json({ error: "Provide at least one caption" });
    }

    if (captions.length > 10) {
      return res.status(400).json({ error: "Maximum 10 captions per batch" });
    }

    const accountId = req.account._id.toString();
    const batchId = crypto.randomUUID();
    const tmpDir = path.join(storage.UPLOAD_DIR, "_tmp", batchId);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Write uploaded video to temp
    const srcVideoPath = path.join(tmpDir, "source" + path.extname(req.file.originalname || ".mp4"));
    fs.writeFileSync(srcVideoPath, req.file.buffer);

    // Build options
    const opts = {};
    if (req.body.fontSize) opts.fontSize = parseInt(req.body.fontSize, 10) || 64;
    if (req.body.textX != null) opts.textX = parseFloat(req.body.textX);
    if (req.body.textY != null) opts.textY = parseFloat(req.body.textY);
    if (req.body.maxDuration) opts.maxDuration = parseInt(req.body.maxDuration, 10) || 10;

    // Output directory
    const outDir = path.join(storage.UPLOAD_DIR, accountId, "reels", batchId);

    logger.info(`Generating ${captions.length} reels for batch ${batchId}`);
    const outputPaths = await generateReels(srcVideoPath, captions, outDir, opts);

    // Build download URLs
    const reels = outputPaths.map((p, i) => ({
      index: i + 1,
      caption: captions[i],
      url: `/uploads/${accountId}/reels/${batchId}/${path.basename(p)}`,
      filename: path.basename(p),
    }));

    // Clean up temp source
    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({ batchId, reels });
  } catch (err) {
    logger.error("Reel generation failed:", err);
    res.status(500).json({ error: "Reel generation failed", details: err.message });
  }
});

/**
 * POST /api/reels/probe
 * Quick probe to get video info (duration, dimensions).
 */
router.post("/probe", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video file" });

    const tmpPath = path.join(storage.UPLOAD_DIR, "_tmp", `probe_${Date.now()}.mp4`);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, req.file.buffer);

    const info = await probeVideo(tmpPath);
    fs.unlinkSync(tmpPath);

    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

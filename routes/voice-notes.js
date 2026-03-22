const express = require("express");
const router = express.Router();
const multer = require("multer");
const { upload: storageUpload, getPresignedUrl, remove } = require("../services/storageService");
const logger = require("../utils/logger").child({ module: "voice-notes" });

const ALLOWED_MIME_TYPES = [
  "audio/mpeg",       // .mp3
  "audio/mp4",        // .m4a
  "audio/ogg",        // .ogg / .opus
  "audio/wav",        // .wav
  "audio/webm",       // .webm (MediaRecorder default)
  "audio/x-m4a",      // .m4a variant
  "audio/aac",        // .aac
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_DURATION_MS = 60_000; // 60 seconds (Instagram voice note limit)

const storage = multer.memoryStorage();
const uploadMiddleware = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported audio format: ${file.mimetype}. Allowed: mp3, m4a, ogg, wav, webm, aac`), false);
    }
  },
});

// POST /api/voice-notes/upload
// Form data: audio (single file), campaign_id (optional)
router.post("/upload", uploadMiddleware.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    const { campaign_id, duration_ms } = req.body;

    // Validate duration if provided
    if (duration_ms && Number(duration_ms) > MAX_DURATION_MS) {
      return res.status(400).json({
        error: `Voice note too long. Maximum duration is ${MAX_DURATION_MS / 1000} seconds.`,
      });
    }

    const accountId = req.account._id.toString();
    const timestamp = Date.now();
    const ext = getExtension(req.file.mimetype);
    const key = `${accountId}/voice-notes/${timestamp}.${ext}`;

    await storageUpload(key, req.file.buffer, req.file.mimetype);

    const url = await getPresignedUrl(key);

    logger.info(`Voice note uploaded: ${key} (${req.file.size} bytes)`);

    res.status(201).json({
      url,
      storage_key: key,
      original_filename: req.file.originalname,
      mime_type: req.file.mimetype,
      file_size: req.file.size,
      duration_ms: duration_ms ? Number(duration_ms) : null,
      campaign_id: campaign_id || null,
    });
  } catch (err) {
    logger.error("Voice note upload failed:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// DELETE /api/voice-notes
// Body: { storage_key }
router.delete("/", async (req, res) => {
  try {
    const { storage_key } = req.body;
    if (!storage_key) {
      return res.status(400).json({ error: "storage_key is required" });
    }

    // Verify the key belongs to this account
    const accountId = req.account._id.toString();
    if (!storage_key.startsWith(`${accountId}/`)) {
      return res.status(403).json({ error: "Not authorized to delete this file" });
    }

    await remove(storage_key);
    logger.info(`Voice note deleted: ${storage_key}`);

    res.json({ success: true });
  } catch (err) {
    logger.error("Voice note delete failed:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

function getExtension(mimeType) {
  const map = {
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
  };
  return map[mimeType] || "audio";
}

module.exports = router;

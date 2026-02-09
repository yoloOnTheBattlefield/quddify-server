const express = require("express");
const multer = require("multer");
const { processUpload } = require("../services/uploadService");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/upload-xlsx
router.post("/upload-xlsx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const result = await processUpload(req.file.buffer, req.file.originalname);
    res.json(result);
  } catch (error) {
    console.error("Upload error:", error);

    if (error.message.startsWith("Invalid filename format")) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

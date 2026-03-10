const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const ClientLut = require("../models/ClientLut");
const { parseCubeFile } = require("../services/lutParser");
const { upload: storeBuffer, getBuffer, remove } = require("../services/storageService");
const logger = require("../utils/logger").child({ module: "client-luts" });

const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".cube", ".3dl"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .cube and .3dl files are allowed"));
    }
  },
});

// GET /api/client-luts?client_id=xxx — list LUTs for a client
router.get("/", async (req, res) => {
  try {
    const { client_id } = req.query;
    if (!client_id) return res.status(400).json({ error: "client_id is required" });

    const luts = await ClientLut.find({
      client_id,
      account_id: req.account._id,
    }).sort({ created_at: -1 });

    res.json({ luts });
  } catch (err) {
    logger.error("Failed to list LUTs:", err);
    res.status(500).json({ error: "Failed to list LUTs" });
  }
});

// POST /api/client-luts/upload — upload a LUT file
router.post("/upload", fileUpload.single("lut"), async (req, res) => {
  try {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: "client_id is required" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const ext = path.extname(req.file.originalname).toLowerCase().replace(".", "");
    const content = req.file.buffer.toString("utf-8");
    const parsed = parseCubeFile(content);

    if (!parsed.size || parsed.data.length === 0) {
      return res.status(400).json({ error: "Invalid LUT file" });
    }

    // Store the raw LUT file
    const storageKey = `${req.account._id}/${client_id}/luts/${Date.now()}-${req.file.originalname}`;
    await storeBuffer(storageKey, req.file.buffer);

    const lut = await ClientLut.create({
      client_id,
      account_id: req.account._id,
      name: req.file.originalname.replace(/\.[^.]+$/, ""),
      storage_key: storageKey,
      original_filename: req.file.originalname,
      format: ext,
      size: parsed.size,
      file_size: req.file.size,
    });

    res.status(201).json({ lut });
  } catch (err) {
    logger.error("Failed to upload LUT:", err);
    res.status(500).json({ error: "Failed to upload LUT" });
  }
});

// DELETE /api/client-luts/:id — delete a LUT
router.delete("/:id", async (req, res) => {
  try {
    const lut = await ClientLut.findOneAndDelete({
      _id: req.params.id,
      account_id: req.account._id,
    });
    if (!lut) return res.status(404).json({ error: "LUT not found" });

    try {
      await remove(lut.storage_key);
    } catch (_e) {
      /* ignore storage cleanup errors */
    }

    res.json({ deleted: true });
  } catch (err) {
    logger.error("Failed to delete LUT:", err);
    res.status(500).json({ error: "Failed to delete LUT" });
  }
});

// GET /api/client-luts/:id/data — get parsed LUT data (for frontend preview)
router.get("/:id/data", async (req, res) => {
  try {
    const lut = await ClientLut.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });
    if (!lut) return res.status(404).json({ error: "LUT not found" });

    const buffer = await getBuffer(lut.storage_key);
    const content = buffer.toString("utf-8");
    const parsed = parseCubeFile(content);

    res.json({
      name: lut.name,
      size: parsed.size,
      data: Array.from(parsed.data), // Send as regular array for JSON
    });
  } catch (err) {
    logger.error("Failed to get LUT data:", err);
    res.status(500).json({ error: "Failed to get LUT data" });
  }
});

module.exports = router;

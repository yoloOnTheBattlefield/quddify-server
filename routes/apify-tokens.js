const express = require("express");
const mongoose = require("mongoose");
const ApifyToken = require("../models/ApifyToken");

const router = express.Router();

// GET /api/apify-tokens — list all tokens for the account
router.get("/", async (req, res) => {
  try {
    const tokens = await ApifyToken.find({ account_id: req.account._id })
      .sort({ createdAt: 1 })
      .lean();

    // Mask token values for security (show first 10 + last 4 chars)
    const masked = tokens.map((t) => ({
      ...t,
      token:
        t.token.length > 14
          ? t.token.slice(0, 10) + "..." + t.token.slice(-4)
          : "****",
    }));

    res.json({ tokens: masked });
  } catch (err) {
    res.status(500).json({ error: "Failed to list tokens" });
  }
});

// POST /api/apify-tokens — add a new token
router.post("/", async (req, res) => {
  try {
    const { label, token } = req.body;
    if (!token || !token.trim()) {
      return res.status(400).json({ error: "Token is required" });
    }

    const doc = await ApifyToken.create({
      account_id: req.account._id,
      label: label?.trim() || "",
      token: token.trim(),
    });

    res.status(201).json({
      _id: doc._id,
      label: doc.label,
      token:
        doc.token.length > 14
          ? doc.token.slice(0, 10) + "..." + doc.token.slice(-4)
          : "****",
      status: doc.status,
      usage_count: doc.usage_count,
      last_used_at: doc.last_used_at,
      createdAt: doc.createdAt,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to add token" });
  }
});

// PATCH /api/apify-tokens/:id — update label or status
router.patch("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid token ID" });
    }

    const doc = await ApifyToken.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!doc) return res.status(404).json({ error: "Token not found" });

    const { label, status, token } = req.body;
    if (label !== undefined) doc.label = label.trim();
    if (status !== undefined) {
      if (!["active", "limit_reached", "disabled"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      doc.status = status;
      if (status === "active") doc.last_error = null;
    }
    if (token !== undefined) {
      if (!token.trim()) return res.status(400).json({ error: "Token cannot be empty" });
      doc.token = token.trim();
    }
    await doc.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update token" });
  }
});

// DELETE /api/apify-tokens/:id
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid token ID" });
    }

    const result = await ApifyToken.deleteOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Token not found" });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete token" });
  }
});

// POST /api/apify-tokens/:id/reset — reset a limit_reached token back to active
router.post("/:id/reset", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid token ID" });
    }

    const doc = await ApifyToken.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!doc) return res.status(404).json({ error: "Token not found" });

    doc.status = "active";
    doc.last_error = null;
    await doc.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to reset token" });
  }
});

module.exports = router;

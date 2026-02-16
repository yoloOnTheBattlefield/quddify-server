const express = require("express");
const mongoose = require("mongoose");
const OutboundAccount = require("../models/OutboundAccount");
const router = express.Router();

// GET /api/outbound-accounts — list with filters, search, pagination
router.get("/", async (req, res) => {
  try {
    const { status, isBlacklisted, isConnectedToAISetter, assignedTo, search, page, limit } = req.query;
    const filter = { account_id: req.account._id };

    if (status) filter.status = status;
    if (isBlacklisted !== undefined) filter.isBlacklisted = isBlacklisted === "true";
    if (isConnectedToAISetter !== undefined) filter.isConnectedToAISetter = isConnectedToAISetter === "true";
    if (assignedTo) filter.assignedTo = { $regex: assignedTo, $options: "i" };
    if (search) {
      filter.$or = [
        { username: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { assignedTo: { $regex: search, $options: "i" } },
        { proxy: { $regex: search, $options: "i" } },
      ];
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 50, 100);
    const skip = (pageNum - 1) * limitNum;

    const [accounts, total] = await Promise.all([
      OutboundAccount.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      OutboundAccount.countDocuments(filter),
    ]);

    res.json({
      accounts,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("List outbound accounts error:", err);
    res.status(500).json({ error: "Failed to list outbound accounts" });
  }
});

// POST /api/outbound-accounts — create account
router.post("/", async (req, res) => {
  try {
    const { username, password, email, emailPassword, proxy, status, isConnectedToAISetter, assignedTo, isBlacklisted, notes, twoFA } = req.body;

    if (!username) {
      return res.status(400).json({ error: "username is required" });
    }

    const clean = username.replace(/^@/, "").trim().toLowerCase();
    if (!clean) {
      return res.status(400).json({ error: "Invalid username" });
    }

    const existing = await OutboundAccount.findOne({
      account_id: req.account._id,
      username: clean,
    }).lean();

    if (existing) {
      return res.status(409).json({ error: "This username already exists" });
    }

    const account = await OutboundAccount.create({
      account_id: req.account._id,
      username: clean,
      password: password || null,
      email: email || null,
      emailPassword: emailPassword || null,
      proxy: proxy || null,
      status: status || "new",
      isConnectedToAISetter: isConnectedToAISetter || false,
      assignedTo: assignedTo || null,
      isBlacklisted: isBlacklisted || false,
      notes: notes || null,
      twoFA: twoFA || null,
    });

    res.status(201).json(account.toObject());
  } catch (err) {
    console.error("Create outbound account error:", err);
    res.status(500).json({ error: "Failed to create outbound account" });
  }
});

// GET /api/outbound-accounts/:id — single account
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid account ID" });
    }

    const account = await OutboundAccount.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    }).lean();

    if (!account) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    res.json(account);
  } catch (err) {
    console.error("Get outbound account error:", err);
    res.status(500).json({ error: "Failed to get outbound account" });
  }
});

// PATCH /api/outbound-accounts/:id — update any field
router.patch("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid account ID" });
    }

    const allowedFields = [
      "username", "password", "email", "emailPassword", "proxy",
      "status", "isConnectedToAISetter", "assignedTo", "isBlacklisted",
      "notes", "twoFA",
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Clean username if being updated
    if (updates.username) {
      updates.username = updates.username.replace(/^@/, "").trim().toLowerCase();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const account = await OutboundAccount.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: updates },
      { new: true },
    ).lean();

    if (!account) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    res.json(account);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "This username already exists" });
    }
    console.error("Update outbound account error:", err);
    res.status(500).json({ error: "Failed to update outbound account" });
  }
});

// DELETE /api/outbound-accounts/:id — delete account
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid account ID" });
    }

    const account = await OutboundAccount.findOneAndDelete({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!account) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    res.json({ deleted: true });
  } catch (err) {
    console.error("Delete outbound account error:", err);
    res.status(500).json({ error: "Failed to delete outbound account" });
  }
});

module.exports = router;

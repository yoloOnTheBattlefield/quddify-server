const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const OutboundAccount = require("../models/OutboundAccount");
const SenderAccount = require("../models/SenderAccount");
const { emitToAccount } = require("../services/socketManager");
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

    // Enrich with linked sender info
    const accountIds = accounts.map((a) => a._id);
    const linkedSenders = accountIds.length
      ? await SenderAccount.find(
          { outbound_account_id: { $in: accountIds } },
          { outbound_account_id: 1, status: 1 },
        ).lean()
      : [];
    const senderByOutbound = {};
    for (const s of linkedSenders) {
      senderByOutbound[s.outbound_account_id.toString()] = s.status;
    }

    const enriched = accounts.map((a) => ({
      ...a,
      linked_sender_status: senderByOutbound[a._id.toString()] || null,
    }));

    res.json({
      accounts: enriched,
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
      "notes", "twoFA", "hidemyacc_profile_id",
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

// POST /api/outbound-accounts/:id/token — generate browser token
router.post("/:id/token", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid account ID" });
    }

    const token = "oat_" + crypto.randomBytes(24).toString("hex");

    const account = await OutboundAccount.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: { browser_token: token } },
      { new: true },
    ).lean();

    if (!account) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    res.json({ browser_token: token });
  } catch (err) {
    console.error("Generate token error:", err);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// DELETE /api/outbound-accounts/:id/token — revoke browser token
router.delete("/:id/token", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid account ID" });
    }

    const account = await OutboundAccount.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: { browser_token: null } },
      { new: true },
    ).lean();

    if (!account) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    // Disconnect any linked sender
    const sender = await SenderAccount.findOneAndUpdate(
      { outbound_account_id: account._id },
      { $set: { status: "offline", socket_id: null, last_seen: new Date() } },
      { new: true },
    );

    if (sender) {
      emitToAccount(req.account._id.toString(), "sender:offline", {
        sender_id: sender._id,
      });
    }

    res.json({ revoked: true });
  } catch (err) {
    console.error("Revoke token error:", err);
    res.status(500).json({ error: "Failed to revoke token" });
  }
});

// PATCH /api/outbound-accounts/me/status — extension sets its own account status
router.patch("/me/status", async (req, res) => {
  try {
    if (!req.outboundAccount) {
      return res.status(403).json({ error: "This endpoint requires a browser token (extension only)" });
    }

    const { status } = req.body;
    const allowed = ["ready", "restricted", "disabled"];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
    }

    const account = await OutboundAccount.findByIdAndUpdate(
      req.outboundAccount._id,
      { $set: { status } },
      { new: true },
    ).lean();

    emitToAccount(req.account._id.toString(), "outbound-account:updated", {
      accountId: account._id,
      status,
    });

    res.json(account);
  } catch (err) {
    console.error("Extension set status error:", err);
    res.status(500).json({ error: "Failed to update status" });
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

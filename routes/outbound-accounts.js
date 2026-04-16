const escapeRegex = require("../utils/escapeRegex");
const logger = require("../utils/logger").child({ module: "outbound-accounts" });
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
        { username: { $regex: escapeRegex(search), $options: "i" } },
        { email: { $regex: escapeRegex(search), $options: "i" } },
        { assignedTo: { $regex: escapeRegex(search), $options: "i" } },
        { proxy: { $regex: escapeRegex(search), $options: "i" } },
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
    logger.error("List outbound accounts error:", err);
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
    logger.error("Create outbound account error:", err);
    res.status(500).json({ error: "Failed to create outbound account" });
  }
});

// POST /api/outbound-accounts/bulk — bulk import accounts from CSV/XLSX
router.post("/bulk", async (req, res) => {
  try {
    const { accounts } = req.body;

    if (!Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({ error: "accounts must be a non-empty array" });
    }
    if (accounts.length > 5000) {
      return res.status(400).json({ error: "Maximum 5000 accounts per import" });
    }

    const errors = [];
    const cleaned = [];

    for (let i = 0; i < accounts.length; i++) {
      const row = accounts[i];
      const raw = row.username;
      if (!raw || typeof raw !== "string" || !raw.trim()) {
        errors.push({ row: i + 1, username: String(raw ?? ""), reason: "Missing username" });
        continue;
      }
      const username = raw.trim().replace(/^@/, "").trim().toLowerCase();
      if (!username) {
        errors.push({ row: i + 1, username: raw, reason: "Invalid username" });
        continue;
      }

      // Validate status if provided
      const validStatuses = ["new", "warming", "ready", "restricted", "disabled"];
      const status = row.status && validStatuses.includes(row.status) ? row.status : "new";

      cleaned.push({
        _index: i + 1,
        account_id: req.account._id,
        username,
        password: row.password || null,
        email: row.email || null,
        emailPassword: row.emailPassword || null,
        proxy: row.proxy || null,
        status,
        assignedTo: row.assignedTo || null,
        notes: row.notes || null,
        twoFA: row.twoFA || null,
        hidemyacc_profile_id: row.hidemyacc_profile_id || null,
      });
    }

    // Deduplicate within the batch (keep first occurrence)
    const seenInBatch = new Map();
    const deduped = [];
    let inBatchDupes = 0;
    for (const item of cleaned) {
      if (seenInBatch.has(item.username)) {
        inBatchDupes++;
        continue;
      }
      seenInBatch.set(item.username, true);
      deduped.push(item);
    }

    // Check which usernames already exist in DB
    const usernames = deduped.map((a) => a.username);
    const existing = await OutboundAccount.find(
      { account_id: req.account._id, username: { $in: usernames } },
      { username: 1 },
    ).lean();
    const existingSet = new Set(existing.map((e) => e.username));

    const toInsert = [];
    let duplicates = inBatchDupes;
    for (const item of deduped) {
      if (existingSet.has(item.username)) {
        duplicates++;
        continue;
      }
      const { _index, ...doc } = item;
      toInsert.push(doc);
    }

    let created = 0;
    if (toInsert.length > 0) {
      try {
        const result = await OutboundAccount.insertMany(toInsert, { ordered: false });
        created = result.length;
      } catch (err) {
        // With ordered: false, some may succeed even if others fail
        if (err.insertedDocs) created = err.insertedDocs.length;
        const writeErrors = err.writeErrors || [];
        for (const we of writeErrors) {
          errors.push({ row: 0, username: toInsert[we.index]?.username || "unknown", reason: we.errmsg || "Write error" });
        }
      }
    }

    res.status(201).json({ created, duplicates, errors });
  } catch (err) {
    logger.error("Bulk import outbound accounts error:", err);
    res.status(500).json({ error: "Failed to bulk import accounts" });
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
    logger.error("Get outbound account error:", err);
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
      "notes", "twoFA", "hidemyacc_profile_id", "daily_limit",
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
    logger.error("Update outbound account error:", err);
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
    logger.error("Generate token error:", err);
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
    logger.error("Revoke token error:", err);
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
    logger.error("Extension set status error:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// PUT /api/outbound-accounts/me/cookies — extension pushes IG cookies
router.put("/me/cookies", async (req, res) => {
  try {
    if (!req.outboundAccount) {
      return res.status(403).json({ error: "This endpoint requires a browser token (extension only)" });
    }

    const { cookies } = req.body;
    if (!Array.isArray(cookies)) {
      return res.status(400).json({ error: "cookies must be an array" });
    }

    const account = await OutboundAccount.findByIdAndUpdate(
      req.outboundAccount._id,
      {
        $set: {
          "ig_cookies.cookies": cookies,
          "ig_cookies.updated_at": new Date(),
        },
      },
      { new: true },
    ).lean();

    logger.info(`Cookies saved for @${account.username} (${cookies.length} cookies)`);

    res.json({ saved: cookies.length, updated_at: account.ig_cookies.updated_at });
  } catch (err) {
    logger.error("Save cookies error:", err);
    res.status(500).json({ error: "Failed to save cookies" });
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
    logger.error("Delete outbound account error:", err);
    res.status(500).json({ error: "Failed to delete outbound account" });
  }
});

module.exports = router;

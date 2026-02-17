const express = require("express");
const mongoose = require("mongoose");
const SenderAccount = require("../models/SenderAccount");
const OutboundAccount = require("../models/OutboundAccount");
const Task = require("../models/Task");
const router = express.Router();

// GET /api/sender-accounts — list senders with upcoming task info
router.get("/", async (req, res) => {
  try {
    const { status, search, page, limit } = req.query;
    const filter = { account_id: req.account._id };

    if (status) filter.status = status;
    if (search) filter.ig_username = { $regex: search, $options: "i" };

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 50, 100);
    const skip = (pageNum - 1) * limitNum;

    const [senders, total] = await Promise.all([
      SenderAccount.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      SenderAccount.countDocuments(filter),
    ]);

    // Attach upcoming task for each sender
    const senderIds = senders.map((s) => s._id);
    const upcomingTasks = await Task.find({
      sender_id: { $in: senderIds },
      status: { $in: ["pending", "in_progress"] },
    })
      .sort({ createdAt: 1 })
      .lean();

    const taskBySender = {};
    for (const task of upcomingTasks) {
      const sid = task.sender_id.toString();
      if (!taskBySender[sid]) {
        taskBySender[sid] = { target: task.target, type: task.type, status: task.status };
      }
    }

    // Attach outbound account info for linked senders
    const outboundIds = senders
      .map((s) => s.outbound_account_id)
      .filter(Boolean);
    const outbounds = outboundIds.length
      ? await OutboundAccount.find(
          { _id: { $in: outboundIds } },
          { _id: 1, username: 1, status: 1 },
        ).lean()
      : [];
    const outboundMap = {};
    for (const ob of outbounds) {
      outboundMap[ob._id.toString()] = ob;
    }

    const enriched = senders.map((s) => {
      const obId = s.outbound_account_id?.toString();
      return {
        ...s,
        upcomingTask: taskBySender[s._id.toString()] || null,
        outbound_account: obId ? outboundMap[obId] || null : null,
        link_status: obId ? "linked" : "not_linked",
      };
    });

    res.json({
      senders: enriched,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("List senders error:", err);
    res.status(500).json({ error: "Failed to list senders" });
  }
});

// POST /api/sender-accounts — manually register an IG account
router.post("/", async (req, res) => {
  try {
    const { ig_username, display_name, daily_limit } = req.body;

    if (!ig_username || typeof ig_username !== "string") {
      return res.status(400).json({ error: "ig_username is required" });
    }

    const clean = ig_username.replace(/^@/, "").trim().toLowerCase();
    if (!clean) {
      return res.status(400).json({ error: "Invalid username" });
    }

    const existing = await SenderAccount.findOne({
      account_id: req.account._id,
      ig_username: clean,
    }).lean();

    if (existing) {
      return res.status(409).json({ error: "This account is already connected" });
    }

    const sender = await SenderAccount.create({
      account_id: req.account._id,
      ig_username: clean,
      display_name: display_name || null,
      daily_limit: daily_limit || 50,
      status: "offline",
    });

    res.status(201).json(sender.toObject());
  } catch (err) {
    console.error("Create sender error:", err);
    res.status(500).json({ error: "Failed to create sender" });
  }
});

// POST /api/sender-accounts/heartbeat — extension pings every 15s
router.post("/heartbeat", async (req, res) => {
  try {
    const { sender_id } = req.body;

    if (!sender_id || !mongoose.Types.ObjectId.isValid(sender_id)) {
      return res.status(400).json({ error: "Valid sender_id is required" });
    }

    const sender = await SenderAccount.findOneAndUpdate(
      { _id: sender_id, account_id: req.account._id },
      { $set: { status: "online", last_seen: new Date() } },
      { new: true },
    ).lean();

    if (!sender) {
      return res.status(404).json({ error: "Sender not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Heartbeat error:", err);
    res.status(500).json({ error: "Heartbeat failed" });
  }
});

// GET /api/sender-accounts/:id — single sender
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid sender ID" });
    }

    const sender = await SenderAccount.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    }).lean();

    if (!sender) {
      return res.status(404).json({ error: "Sender not found" });
    }

    res.json(sender);
  } catch (err) {
    console.error("Get sender error:", err);
    res.status(500).json({ error: "Failed to get sender" });
  }
});

// PATCH /api/sender-accounts/:id — update display_name, daily_limit
router.patch("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid sender ID" });
    }

    const updates = {};
    if (req.body.display_name !== undefined) updates.display_name = req.body.display_name;
    if (req.body.daily_limit !== undefined) updates.daily_limit = req.body.daily_limit;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const sender = await SenderAccount.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: updates },
      { new: true },
    ).lean();

    if (!sender) {
      return res.status(404).json({ error: "Sender not found" });
    }

    res.json(sender);
  } catch (err) {
    console.error("Update sender error:", err);
    res.status(500).json({ error: "Failed to update sender" });
  }
});

// DELETE /api/sender-accounts/:id — remove sender
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid sender ID" });
    }

    const sender = await SenderAccount.findOneAndDelete({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!sender) {
      return res.status(404).json({ error: "Sender not found" });
    }

    res.json({ deleted: true });
  } catch (err) {
    console.error("Delete sender error:", err);
    res.status(500).json({ error: "Failed to delete sender" });
  }
});

module.exports = router;

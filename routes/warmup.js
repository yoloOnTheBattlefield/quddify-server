const express = require("express");
const mongoose = require("mongoose");
const OutboundAccount = require("../models/OutboundAccount");
const WarmupLog = require("../models/WarmupLog");
const router = express.Router();

const DEFAULT_SCHEDULE = [
  { day: 1, cap: 0 },
  { day: 2, cap: 0 },
  { day: 3, cap: 0 },
  { day: 4, cap: 0 },
  { day: 5, cap: 0 },
  { day: 6, cap: 0 },
  { day: 7, cap: 0 },
  { day: 8, cap: 0 },
  { day: 9, cap: 5 },
  { day: 10, cap: 8 },
  { day: 11, cap: 12 },
  { day: 12, cap: 15 },
  { day: 13, cap: 20 },
  { day: 14, cap: 25 },
];

const DEFAULT_CHECKLIST = [
  { key: "profile_photo", label: "Upload profile photo" },
  { key: "bio", label: "Complete bio" },
  { key: "posts_3", label: "Publish 3 posts" },
  { key: "follow_10", label: "Follow 10 relevant accounts" },
  { key: "like_20", label: "Like 20 posts" },
  { key: "story", label: "Post a story" },
  { key: "comment_5", label: "Comment on 5 posts" },
];

function getWarmupDay(startDate) {
  const msPerDay = 86400000;
  return Math.floor((Date.now() - new Date(startDate).getTime()) / msPerDay) + 1;
}

// GET /api/warmup/:outboundAccountId — warmup status
router.get("/:outboundAccountId", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.outboundAccountId)) {
      return res.status(400).json({ error: "Invalid account ID" });
    }

    const account = await OutboundAccount.findOne({
      _id: req.params.outboundAccountId,
      account_id: req.account._id,
    }).lean();

    if (!account) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    const warmup = account.warmup || {};
    if (!warmup.enabled || !warmup.startDate) {
      return res.json({
        enabled: false,
        startDate: null,
        currentDay: 0,
        todayCap: null,
        automationBlocked: false,
        schedule: DEFAULT_SCHEDULE,
        checklist: [],
        checklistProgress: { completed: 0, total: 0 },
      });
    }

    const currentDay = getWarmupDay(warmup.startDate);
    const scheduleEntry = (warmup.schedule || []).find((s) => s.day === currentDay);
    const todayCap = scheduleEntry ? scheduleEntry.cap : null;
    const automationBlocked = currentDay < 9;
    const checklist = warmup.checklist || [];
    const completed = checklist.filter((c) => c.completed).length;

    res.json({
      enabled: true,
      startDate: warmup.startDate,
      currentDay,
      todayCap,
      automationBlocked,
      schedule: warmup.schedule || DEFAULT_SCHEDULE,
      checklist,
      checklistProgress: { completed, total: checklist.length },
    });
  } catch (err) {
    console.error("Get warmup status error:", err);
    res.status(500).json({ error: "Failed to get warmup status" });
  }
});

// POST /api/warmup/:outboundAccountId/start — start warmup
router.post("/:outboundAccountId/start", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.outboundAccountId)) {
      return res.status(400).json({ error: "Invalid account ID" });
    }

    const account = await OutboundAccount.findOne({
      _id: req.params.outboundAccountId,
      account_id: req.account._id,
    });

    if (!account) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    if (account.warmup && account.warmup.enabled) {
      return res.status(400).json({ error: "Warmup is already active" });
    }

    const checklist = DEFAULT_CHECKLIST.map((item) => ({
      key: item.key,
      label: item.label,
      completed: false,
      completedAt: null,
      completedBy: null,
    }));

    account.warmup = {
      enabled: true,
      startDate: new Date(),
      schedule: [...DEFAULT_SCHEDULE],
      checklist,
    };
    account.status = "warming";
    await account.save();

    await WarmupLog.create({
      account_id: req.account._id,
      outbound_account_id: account._id,
      action: "warmup_started",
      details: { username: account.username },
      performedBy: req.account.email || "system",
    });

    res.json(account.toObject());
  } catch (err) {
    console.error("Start warmup error:", err);
    res.status(500).json({ error: "Failed to start warmup" });
  }
});

// POST /api/warmup/:outboundAccountId/stop — stop warmup
router.post("/:outboundAccountId/stop", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.outboundAccountId)) {
      return res.status(400).json({ error: "Invalid account ID" });
    }

    const account = await OutboundAccount.findOneAndUpdate(
      {
        _id: req.params.outboundAccountId,
        account_id: req.account._id,
      },
      {
        $set: {
          "warmup.enabled": false,
          "warmup.startDate": null,
        },
      },
      { new: true },
    ).lean();

    if (!account) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    await WarmupLog.create({
      account_id: req.account._id,
      outbound_account_id: account._id,
      action: "warmup_stopped",
      details: { username: account.username },
      performedBy: req.account.email || "system",
    });

    res.json(account);
  } catch (err) {
    console.error("Stop warmup error:", err);
    res.status(500).json({ error: "Failed to stop warmup" });
  }
});

// PATCH /api/warmup/:outboundAccountId/checklist/:key — toggle checklist item
router.patch("/:outboundAccountId/checklist/:key", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.outboundAccountId)) {
      return res.status(400).json({ error: "Invalid account ID" });
    }

    const account = await OutboundAccount.findOne({
      _id: req.params.outboundAccountId,
      account_id: req.account._id,
    });

    if (!account) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    if (!account.warmup || !account.warmup.checklist) {
      return res.status(400).json({ error: "Warmup is not active" });
    }

    const item = account.warmup.checklist.find((c) => c.key === req.params.key);
    if (!item) {
      return res.status(404).json({ error: "Checklist item not found" });
    }

    const newCompleted = !item.completed;
    item.completed = newCompleted;
    item.completedAt = newCompleted ? new Date() : null;
    item.completedBy = newCompleted ? (req.account.email || "system") : null;

    await account.save();

    await WarmupLog.create({
      account_id: req.account._id,
      outbound_account_id: account._id,
      action: "checklist_toggled",
      details: {
        key: item.key,
        label: item.label,
        completed: newCompleted,
      },
      performedBy: req.account.email || "system",
    });

    res.json(account.toObject());
  } catch (err) {
    console.error("Toggle checklist error:", err);
    res.status(500).json({ error: "Failed to toggle checklist item" });
  }
});

// GET /api/warmup/:outboundAccountId/logs — audit logs
router.get("/:outboundAccountId/logs", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.outboundAccountId)) {
      return res.status(400).json({ error: "Invalid account ID" });
    }

    // Verify the outbound account belongs to this tenant
    const account = await OutboundAccount.findOne({
      _id: req.params.outboundAccountId,
      account_id: req.account._id,
    }).lean();

    if (!account) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    const pageNum = parseInt(req.query.page, 10) || 1;
    const limitNum = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const skip = (pageNum - 1) * limitNum;

    const [logs, total] = await Promise.all([
      WarmupLog.find({ outbound_account_id: req.params.outboundAccountId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      WarmupLog.countDocuments({ outbound_account_id: req.params.outboundAccountId }),
    ]);

    res.json({
      logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("Get warmup logs error:", err);
    res.status(500).json({ error: "Failed to get warmup logs" });
  }
});

module.exports = router;

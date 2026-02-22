const express = require("express");
const mongoose = require("mongoose");
const Task = require("../models/Task");
const OutboundLead = require("../models/OutboundLead");
const CampaignLead = require("../models/CampaignLead");
const Campaign = require("../models/Campaign");
const { emitToAccount } = require("../services/socketManager");

const router = express.Router();

// POST /api/tasks/ping — send a ping to the extension via websocket
router.post("/ping", async (req, res) => {
  const accountId = req.account._id.toString();
  emitToAccount(accountId, "ext:ping", {
    message: req.body.message || "ping",
    timestamp: new Date(),
  });
  res.json({ sent: true });
});

// GET /api/tasks/next — atomic pickup of next pending task
router.get("/next", async (req, res) => {
  try {
    const filter = { account_id: req.account._id, status: "pending" };

    // If sender_id provided, only pick tasks assigned to this sender (or unassigned)
    if (req.query.sender_id) {
      filter.$or = [
        { sender_id: req.query.sender_id },
        { sender_id: null },
      ];
    }

    const task = await Task.findOneAndUpdate(
      filter,
      {
        $set: { status: "in_progress", startedAt: new Date() },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, new: true },
    ).lean();

    res.json(task || null);
  } catch (err) {
    console.error("Get next task error:", err);
    res.status(500).json({ error: "Failed to get next task" });
  }
});

// POST /api/tasks/:taskId/complete — mark completed, auto-update OutboundLead
router.post("/:taskId/complete", async (req, res) => {
  try {
    const { taskId } = req.params;
    const { result } = req.body;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json({ error: "Invalid task ID" });
    }

    const task = await Task.findOne({
      _id: taskId,
      account_id: req.account._id,
    });

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    if (task.status === "completed") {
      return res.status(400).json({ error: "Task is already completed" });
    }

    task.status = "completed";
    task.completedAt = new Date();
    task.result = {
      success: result?.success ?? true,
      username: result?.username || task.target,
      threadId: result?.threadId || null,
      timestamp: result?.timestamp ? new Date(result.timestamp) : new Date(),
    };
    await task.save();

    // Auto-update OutboundLead for send_dm tasks
    if (task.type === "send_dm" && task.outbound_lead_id) {
      const outboundUpdate = {
        isMessaged: true,
        dmDate: new Date(),
        message: task.message,
      };
      if (result?.threadId) outboundUpdate.ig_thread_id = result.threadId;
      await OutboundLead.findByIdAndUpdate(task.outbound_lead_id, {
        $set: outboundUpdate,
      });
    }

    // Update CampaignLead + Campaign stats if this is a campaign task
    if (task.campaign_lead_id) {
      await CampaignLead.findByIdAndUpdate(task.campaign_lead_id, {
        $set: { status: "sent", sent_at: new Date() },
      });
      await Campaign.findByIdAndUpdate(task.campaign_id, {
        $inc: { "stats.queued": -1, "stats.sent": 1 },
      });
    }

    emitToAccount(req.account._id.toString(), "task:completed", {
      _id: task._id,
      target: task.target,
      result: task.result,
    });

    res.json({ success: true, message: "Task marked as completed" });
  } catch (err) {
    console.error("Complete task error:", err);
    res.status(500).json({ error: "Failed to complete task" });
  }
});

// POST /api/tasks/:taskId/failed — mark failed with error details
router.post("/:taskId/failed", async (req, res) => {
  try {
    const { taskId } = req.params;
    const { error: errorMsg, errorType, stackTrace, timestamp } = req.body;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json({ error: "Invalid task ID" });
    }

    const task = await Task.findOne({
      _id: taskId,
      account_id: req.account._id,
    });

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    if (task.status === "completed") {
      return res.status(400).json({ error: "Cannot fail a completed task" });
    }

    task.status = "failed";
    task.failedAt = new Date();
    task.error = {
      error: errorMsg || "Unknown error",
      errorType: errorType || "UNKNOWN",
      stackTrace: stackTrace || null,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    };
    await task.save();

    // Update CampaignLead + Campaign stats if this is a campaign task
    if (task.campaign_lead_id) {
      await CampaignLead.findByIdAndUpdate(task.campaign_lead_id, {
        $set: { status: "failed", error: errorMsg || "Unknown error" },
      });
      await Campaign.findByIdAndUpdate(task.campaign_id, {
        $inc: { "stats.queued": -1, "stats.failed": 1 },
      });
    }

    emitToAccount(req.account._id.toString(), "task:failed", {
      _id: task._id,
      target: task.target,
      error: task.error,
    });

    res.json({ success: true, message: "Task marked as failed" });
  } catch (err) {
    console.error("Fail task error:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
});

// POST /api/tasks — create task(s), supports batch via { tasks: [...] }
router.post("/", async (req, res) => {
  try {
    const taskArray = req.body.tasks || [req.body];

    if (!Array.isArray(taskArray) || taskArray.length === 0) {
      return res.status(400).json({ error: "At least one task is required" });
    }

    const docs = taskArray.map((t) => ({
      account_id: req.account._id,
      type: t.type || "send_dm",
      target: t.target,
      outbound_lead_id: t.outbound_lead_id || null,
      sender_id: t.sender_id || null,
      campaign_id: t.campaign_id || null,
      campaign_lead_id: t.campaign_lead_id || null,
      message: t.message || null,
      metadata: t.metadata || {},
      status: "pending",
    }));

    const invalid = docs.find((d) => !d.target);
    if (invalid) {
      return res
        .status(400)
        .json({ error: "Each task must have a target (Instagram username)" });
    }

    const created = await Task.insertMany(docs);

    // Notify extension via websocket
    const accountId = req.account._id.toString();
    for (const task of created) {
      emitToAccount(accountId, "task:new", task);
    }

    res.status(201).json({ tasks: created, count: created.length });
  } catch (err) {
    console.error("Create tasks error:", err);
    res.status(500).json({ error: "Failed to create tasks" });
  }
});

// GET /api/tasks — list with filtering and pagination
router.get("/", async (req, res) => {
  try {
    const { status, type, search, page, limit } = req.query;
    const filter = { account_id: req.account._id };

    if (status) filter.status = status;
    if (type) filter.type = type;
    if (search) filter.target = { $regex: search, $options: "i" };

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const skip = (pageNum - 1) * limitNum;

    const [tasks, total] = await Promise.all([
      Task.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Task.countDocuments(filter),
    ]);

    res.json({
      tasks,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("List tasks error:", err);
    res.status(500).json({ error: "Failed to list tasks" });
  }
});

// POST /api/tasks/reset-stuck — reset all stuck tasks + their campaign leads
router.post("/reset-stuck", async (req, res) => {
  try {
    const stuckTasks = await Task.find({
      account_id: req.account._id,
      status: { $in: ["pending", "in_progress"] },
    }).lean();

    if (stuckTasks.length === 0) {
      return res.json({ reset: 0, message: "No stuck tasks found" });
    }

    let resetCount = 0;

    for (const task of stuckTasks) {
      await Task.findByIdAndUpdate(task._id, {
        $set: { status: "failed", error: "Manually reset", failedAt: new Date() },
      });

      if (task.campaign_lead_id) {
        const resetResult = await CampaignLead.findOneAndUpdate(
          { _id: task.campaign_lead_id, status: "queued" },
          { $set: { status: "pending", sender_id: null, queued_at: null, task_id: null } },
        );

        if (resetResult && task.campaign_id) {
          await Campaign.findByIdAndUpdate(task.campaign_id, {
            $inc: { "stats.queued": -1, "stats.pending": 1 },
          });
        }
      }

      resetCount++;
    }

    res.json({ reset: resetCount, message: `Reset ${resetCount} stuck task(s)` });
  } catch (err) {
    console.error("Reset stuck tasks error:", err);
    res.status(500).json({ error: "Failed to reset stuck tasks" });
  }
});

module.exports = router;

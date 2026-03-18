const logger = require("../utils/logger").child({ module: "lead-tasks" });
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const LeadTask = require("../models/LeadTask");

// GET /api/lead-tasks?lead_id=xxx — list tasks for a lead
router.get("/", async (req, res) => {
  try {
    const { lead_id } = req.query;
    if (!lead_id) return res.status(400).json({ error: "lead_id is required" });

    const accountId = req.account._id;
    const tasks = await LeadTask.find({
      lead_id: new mongoose.Types.ObjectId(lead_id),
      account_id: accountId,
    }).sort({ completed_at: 1, due_date: 1, createdAt: -1 });

    res.json(tasks);
  } catch (err) {
    logger.error({ err }, "Failed to list lead tasks");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/lead-tasks — create a task
router.post("/", async (req, res) => {
  try {
    const { lead_id, title, due_date } = req.body;
    if (!lead_id || !title?.trim()) {
      return res.status(400).json({ error: "lead_id and title are required" });
    }

    const accountId = req.account._id;
    const task = await LeadTask.create({
      lead_id: new mongoose.Types.ObjectId(lead_id),
      account_id: accountId,
      author_id: req.user._id || req.user.id,
      author_name: `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || req.user.email,
      title: title.trim(),
      due_date: due_date || null,
    });

    logger.info({ taskId: task._id, leadId: lead_id }, "Task created");
    res.status(201).json(task);
  } catch (err) {
    logger.error({ err }, "Failed to create lead task");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/lead-tasks/:id — update a task (toggle complete, edit title/due_date)
router.patch("/:id", async (req, res) => {
  try {
    const accountId = req.account._id;
    const updates = {};

    if (req.body.title !== undefined) updates.title = req.body.title.trim();
    if (req.body.due_date !== undefined) updates.due_date = req.body.due_date;
    if (req.body.completed_at !== undefined) updates.completed_at = req.body.completed_at;

    const task = await LeadTask.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(req.params.id),
        account_id: accountId,
      },
      { $set: updates },
      { new: true },
    );

    if (!task) return res.status(404).json({ error: "Task not found" });

    logger.info({ taskId: req.params.id }, "Task updated");
    res.json(task);
  } catch (err) {
    logger.error({ err }, "Failed to update lead task");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/lead-tasks/:id — delete a task
router.delete("/:id", async (req, res) => {
  try {
    const accountId = req.account._id;
    const task = await LeadTask.findOneAndDelete({
      _id: new mongoose.Types.ObjectId(req.params.id),
      account_id: accountId,
    });

    if (!task) return res.status(404).json({ error: "Task not found" });

    logger.info({ taskId: req.params.id }, "Task deleted");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete lead task");
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

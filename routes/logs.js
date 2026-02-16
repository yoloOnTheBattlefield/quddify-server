const express = require("express");
const ExtensionLog = require("../models/ExtensionLog");
const router = express.Router();

// POST /api/logs — store single log event
router.post("/", async (req, res) => {
  try {
    const { event, taskId, level, data, timestamp } = req.body;

    if (!event) {
      return res.status(400).json({ error: "event is required" });
    }

    await ExtensionLog.create({
      account_id: req.account._id,
      event,
      taskId: taskId || null,
      level: level || "info",
      data: data || {},
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    });

    res.status(201).json({ success: true });
  } catch (err) {
    console.error("Create log error:", err);
    res.status(500).json({ error: "Failed to create log" });
  }
});

// POST /api/logs/batch — store multiple log events at once
router.post("/batch", async (req, res) => {
  try {
    const { logs } = req.body;

    if (!Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({ error: "logs array is required" });
    }

    const docs = logs.map((l) => ({
      account_id: req.account._id,
      event: l.event,
      taskId: l.taskId || null,
      level: l.level || "info",
      data: l.data || {},
      timestamp: l.timestamp ? new Date(l.timestamp) : new Date(),
    }));

    const created = await ExtensionLog.insertMany(docs);
    res.status(201).json({ success: true, count: created.length });
  } catch (err) {
    console.error("Batch log error:", err);
    res.status(500).json({ error: "Failed to create logs" });
  }
});

module.exports = router;

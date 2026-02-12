const express = require("express");
const mongoose = require("mongoose");
const Task = require("../models/Task");
const apiKeyAuth = require("../middleware/apiKeyAuth");

const router = express.Router();

// GET /api/health — no auth required
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// GET /api/stats — requires auth, aggregates task counts
router.get("/stats", apiKeyAuth, async (req, res) => {
  try {
    const accountId = req.account._id;

    const [stats] = await Task.aggregate([
      { $match: { account_id: new mongoose.Types.ObjectId(accountId) } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
          in_progress: { $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        },
      },
    ]);

    res.json(
      stats || { total: 0, pending: 0, in_progress: 0, completed: 0, failed: 0 },
    );
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

module.exports = router;

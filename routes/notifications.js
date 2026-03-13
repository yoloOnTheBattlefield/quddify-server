const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");
const logger = require("../utils/logger").child({ module: "notifications" });

// GET /api/notifications?unread_only=true
router.get("/", async (req, res) => {
  try {
    const filter = { account_id: req.account._id };
    if (req.query.unread_only === "true") filter.read = false;
    const notifications = await Notification.find(filter).sort({ created_at: -1 }).limit(50);
    const unread_count = await Notification.countDocuments({ account_id: req.account._id, read: false });
    res.json({ notifications, unread_count });
  } catch (err) {
    logger.error("Failed to list notifications:", err);
    res.status(500).json({ error: "Failed to list notifications" });
  }
});

// PATCH /api/notifications/:id/read
router.patch("/:id/read", async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: { read: true } },
      { new: true },
    );
    if (!notification) return res.status(404).json({ error: "Notification not found" });
    res.json(notification);
  } catch (err) {
    logger.error("Failed to mark notification read:", err);
    res.status(500).json({ error: "Failed to mark notification read" });
  }
});

// POST /api/notifications/read-all
router.post("/read-all", async (req, res) => {
  try {
    await Notification.updateMany({ account_id: req.account._id, read: false }, { $set: { read: true } });
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to mark all read:", err);
    res.status(500).json({ error: "Failed to mark all read" });
  }
});

module.exports = router;

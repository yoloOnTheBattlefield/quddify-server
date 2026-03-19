const express = require("express");
const router = express.Router();
const PushSubscription = require("../models/PushSubscription");
const logger = require("../utils/logger").child({ module: "push-subscriptions" });

// GET /api/push-subscriptions/vapid-public-key
router.get("/vapid-public-key", (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: "Push notifications not configured" });
  res.json({ publicKey: key });
});

// POST /api/push-subscriptions — save a push subscription
router.post("/", async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: "Invalid subscription payload" });
    }

    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { account_id: req.account._id, endpoint, keys },
      { upsert: true, new: true },
    );

    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to save push subscription:", err);
    res.status(500).json({ error: "Failed to save push subscription" });
  }
});

// DELETE /api/push-subscriptions — remove a push subscription
router.delete("/", async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: "endpoint required" });

    await PushSubscription.deleteOne({ account_id: req.account._id, endpoint });
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete push subscription:", err);
    res.status(500).json({ error: "Failed to delete push subscription" });
  }
});

module.exports = router;

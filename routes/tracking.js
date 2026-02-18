const express = require("express");
const Account = require("../models/Account");
const TrackingEvent = require("../models/TrackingEvent");

const router = express.Router();

// GET /tracking/settings — return tracking settings for the account
router.get("/settings", async (req, res) => {
  try {
    const account = await Account.findById(
      req.account._id,
      "tracking_enabled tracking_conversion_rules",
    ).lean();
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    res.json({
      tracking_enabled: !!account.tracking_enabled,
      tracking_conversion_rules: account.tracking_conversion_rules || [],
    });
  } catch (err) {
    console.error("Tracking settings error:", err);
    res.status(500).json({ error: "Failed to fetch tracking settings" });
  }
});

// PATCH /tracking/settings — update tracking settings
router.patch("/settings", async (req, res) => {
  try {
    const updates = {};
    if (req.body.tracking_enabled !== undefined) {
      updates.tracking_enabled = !!req.body.tracking_enabled;
    }
    if (req.body.tracking_conversion_rules !== undefined) {
      updates.tracking_conversion_rules = req.body.tracking_conversion_rules;
    }

    const account = await Account.findByIdAndUpdate(req.account._id, { $set: updates }, { new: true })
      .select("tracking_enabled tracking_conversion_rules")
      .lean();

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    res.json({
      tracking_enabled: !!account.tracking_enabled,
      tracking_conversion_rules: account.tracking_conversion_rules || [],
    });
  } catch (err) {
    console.error("Update tracking settings error:", err);
    res.status(500).json({ error: "Failed to update tracking settings" });
  }
});

// GET /tracking/events — recent tracking events
// Admins (role 0) can pass ?account_id= to query a specific client's events
// Admins (role 0) can pass ?account_id=all to query all events across all clients
router.get("/events", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 50);

    const isAdmin = req.user && req.user.role === 0;
    let filter;

    if (req.query.account_id && isAdmin) {
      if (req.query.account_id === "all") {
        filter = {};
      } else {
        filter = { account_id: req.query.account_id };
      }
    } else {
      filter = { account_id: req.account._id };
    }

    const events = await TrackingEvent.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ events });
  } catch (err) {
    console.error("Tracking events error:", err);
    res.status(500).json({ error: "Failed to fetch tracking events" });
  }
});

module.exports = router;

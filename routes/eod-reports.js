const logger = require("../utils/logger").child({ module: "eod-reports" });
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const EodReport = require("../models/EodReport");
const CampaignLead = require("../models/CampaignLead");
const OutboundLead = require("../models/OutboundLead");
const Campaign = require("../models/Campaign");
const FollowUp = require("../models/FollowUp");

const DEFAULT_CHECKLIST = [
  "Reviewed pipeline and prioritized follow-ups",
  "Sent all scheduled DMs",
  "Responded to all replies within 1 hour",
  "Updated lead statuses",
  "Logged all bookings and outcomes",
  "Reviewed analytics for improvements",
];

function todayStr() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayRange(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day, 23, 59, 59, 999);
  return { start, end };
}

// GET /api/eod-reports/today — get or auto-create today's report
router.get("/today", async (req, res) => {
  try {
    const accountId = req.account._id;
    const userId = req.user._id || req.user.id;
    const userName = `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || req.user.email;
    const date = todayStr();
    const { start, end } = dayRange(date);

    // Auto-populate stats
    const accountCampaigns = await Campaign.find({ account_id: accountId }).select("_id").lean();
    const campaignIds = accountCampaigns.map((c) => c._id);

    const [dmsSent, repliesReceived, bookingsMade, followUpsCompleted] = await Promise.all([
      CampaignLead.countDocuments({
        campaign_id: { $in: campaignIds },
        status: { $in: ["sent", "delivered", "replied"] },
        sent_at: { $gte: start, $lte: end },
      }),
      OutboundLead.countDocuments({
        account_id: accountId,
        replied_at: { $gte: start, $lte: end },
      }),
      OutboundLead.countDocuments({
        account_id: accountId,
        booked_at: { $gte: start, $lte: end },
      }),
      FollowUp.countDocuments({
        account_id: accountId,
        status: { $in: ["booked", "not_interested"] },
        updatedAt: { $gte: start, $lte: end },
      }),
    ]);

    const stats = {
      dms_sent: dmsSent,
      replies_received: repliesReceived,
      bookings_made: bookingsMade,
      follow_ups_completed: followUpsCompleted,
    };

    // Find existing or create new
    let report = await EodReport.findOne({ account_id: accountId, user_id: userId, date });

    if (report) {
      // Update stats on every fetch
      report.stats = stats;
      await report.save();
    } else {
      report = await EodReport.create({
        account_id: accountId,
        user_id: userId,
        user_name: userName,
        date,
        stats,
        checklist: DEFAULT_CHECKLIST.map((label) => ({ label, checked: false })),
        notes: "",
        mood: null,
      });
    }

    res.json(report);
  } catch (err) {
    logger.error({ err }, "Failed to get today's EOD report");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/eod-reports/team — all team members' reports for a given date
router.get("/team", async (req, res) => {
  try {
    const accountId = req.account._id;
    const date = req.query.date || todayStr();

    const reports = await EodReport.find({ account_id: accountId, date })
      .sort({ user_name: 1 })
      .lean();

    res.json(reports);
  } catch (err) {
    logger.error({ err }, "Failed to get team EOD reports");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/eod-reports — list reports for account, paginated
router.get("/", async (req, res) => {
  try {
    const accountId = req.account._id;
    const { date, user_id, page, limit } = req.query;

    const filter = { account_id: accountId };
    if (date) filter.date = date;
    if (user_id) filter.user_id = user_id;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const [reports, total] = await Promise.all([
      EodReport.find(filter).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      EodReport.countDocuments(filter),
    ]);

    res.json({
      reports,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to list EOD reports");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/eod-reports — upsert today's report
router.post("/", async (req, res) => {
  try {
    const accountId = req.account._id;
    const userId = req.user._id || req.user.id;
    const userName = `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || req.user.email;
    const date = todayStr();

    const updates = {};
    if (req.body.checklist !== undefined) updates.checklist = req.body.checklist;
    if (req.body.notes !== undefined) updates.notes = req.body.notes;
    if (req.body.mood !== undefined) updates.mood = req.body.mood;

    const report = await EodReport.findOneAndUpdate(
      { account_id: accountId, user_id: userId, date },
      {
        $set: updates,
        $setOnInsert: {
          account_id: accountId,
          user_id: userId,
          user_name: userName,
          date,
          stats: { dms_sent: 0, replies_received: 0, bookings_made: 0, follow_ups_completed: 0 },
        },
      },
      { upsert: true, new: true },
    );

    logger.info({ reportId: report._id, date }, "EOD report upserted");
    res.json(report);
  } catch (err) {
    logger.error({ err }, "Failed to upsert EOD report");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/eod-reports/:id — update checklist, notes, mood
router.patch("/:id", async (req, res) => {
  try {
    const accountId = req.account._id;
    const updates = {};
    if (req.body.checklist !== undefined) updates.checklist = req.body.checklist;
    if (req.body.notes !== undefined) updates.notes = req.body.notes;
    if (req.body.mood !== undefined) updates.mood = req.body.mood;

    const report = await EodReport.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(req.params.id), account_id: accountId },
      { $set: updates },
      { new: true },
    );

    if (!report) return res.status(404).json({ error: "Report not found" });

    logger.info({ reportId: req.params.id }, "EOD report updated");
    res.json(report);
  } catch (err) {
    logger.error({ err }, "Failed to update EOD report");
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

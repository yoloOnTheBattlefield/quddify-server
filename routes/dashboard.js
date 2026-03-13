const express = require("express");
const router = express.Router();
const Client = require("../models/Client");
const Carousel = require("../models/Carousel");
const Transcript = require("../models/Transcript");
const ClientImage = require("../models/ClientImage");
const logger = require("../utils/logger").child({ module: "dashboard" });

// GET /api/dashboard/overview — agency-level overview across all clients
router.get("/overview", async (req, res) => {
  try {
    const accountId = req.account._id;

    const [clients, carousels, transcriptCounts, imageCounts] = await Promise.all([
      Client.find({ account_id: accountId }).lean(),
      Carousel.find({ account_id: accountId }).sort({ created_at: -1 }).lean(),
      Transcript.aggregate([
        { $match: { account_id: accountId } },
        { $group: { _id: "$client_id", count: { $sum: 1 } } },
      ]),
      ClientImage.aggregate([
        { $match: { account_id: accountId, status: "ready" } },
        { $group: { _id: "$client_id", count: { $sum: 1 } } },
      ]),
    ]);

    const transcriptMap = Object.fromEntries(transcriptCounts.map((t) => [t._id.toString(), t.count]));
    const imageMap = Object.fromEntries(imageCounts.map((i) => [i._id.toString(), i.count]));

    const clientSummaries = clients.map((client) => {
      const clientCarousels = carousels.filter((c) => c.client_id.toString() === client._id.toString());
      const readyCarousels = clientCarousels.filter((c) => c.status === "ready");
      const lastCarousel = clientCarousels[0] || null;

      return {
        _id: client._id,
        name: client.name,
        slug: client.slug,
        niche: client.niche,
        total_carousels: clientCarousels.length,
        ready_carousels: readyCarousels.length,
        pending_carousels: clientCarousels.filter((c) => c.status === "queued" || c.status === "generating").length,
        failed_carousels: clientCarousels.filter((c) => c.status === "failed").length,
        total_transcripts: transcriptMap[client._id.toString()] || 0,
        total_images: imageMap[client._id.toString()] || 0,
        last_carousel_date: lastCarousel?.created_at || null,
        avg_confidence: readyCarousels.length > 0
          ? Math.round(readyCarousels.reduce((sum, c) => sum + (c.confidence?.overall || 0), 0) / readyCarousels.length)
          : null,
        has_brand_kit: !!(client.brand_kit?.primary_color && client.brand_kit.primary_color !== "#000000"),
        has_voice_profile: !!(client.voice_profile?.raw_text),
      };
    });

    const recentCarousels = carousels.slice(0, 20).map((c) => ({
      _id: c._id,
      client_id: c.client_id,
      client_name: clients.find((cl) => cl._id.toString() === c.client_id.toString())?.name || "Unknown",
      goal: c.goal,
      slides_count: c.slides?.length || 0,
      confidence: c.confidence?.overall || 0,
      status: c.status,
      created_at: c.created_at,
    }));

    res.json({
      totals: {
        clients: clients.length,
        carousels: carousels.length,
        ready_carousels: carousels.filter((c) => c.status === "ready").length,
        pending_carousels: carousels.filter((c) => c.status === "queued" || c.status === "generating").length,
      },
      clients: clientSummaries,
      recent_carousels: recentCarousels,
    });
  } catch (err) {
    logger.error("Failed to get dashboard overview:", err);
    res.status(500).json({ error: "Failed to get dashboard overview" });
  }
});

// GET /api/dashboard/calendar?month=2026-03 — get all carousels for a month with scheduled dates
router.get("/calendar", async (req, res) => {
  try {
    const accountId = req.account._id;
    const month = req.query.month; // e.g. "2026-03"

    let startDate, endDate;
    if (month) {
      startDate = new Date(`${month}-01T00:00:00.000Z`);
      endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
    } else {
      // Default: current month
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    }

    const clients = await Client.find({ account_id: accountId }).lean();

    // Get carousels that are either scheduled in this month or created in this month
    const carousels = await Carousel.find({
      account_id: accountId,
      $or: [
        { scheduled_date: { $gte: startDate, $lt: endDate } },
        { scheduled_date: null, created_at: { $gte: startDate, $lt: endDate }, status: "ready" },
      ],
    }).sort({ scheduled_date: 1, created_at: 1 }).lean();

    const events = carousels.map((c) => ({
      _id: c._id,
      client_id: c.client_id,
      client_name: clients.find((cl) => cl._id.toString() === c.client_id.toString())?.name || "Unknown",
      goal: c.goal,
      status: c.status,
      confidence: c.confidence?.overall || 0,
      slides_count: c.slides?.length || 0,
      scheduled_date: c.scheduled_date || null,
      created_at: c.created_at,
      date: c.scheduled_date || c.created_at,
    }));

    res.json({ events, month: month || `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}` });
  } catch (err) {
    logger.error("Failed to get calendar:", err);
    res.status(500).json({ error: "Failed to get calendar" });
  }
});

// PATCH /api/dashboard/schedule/:id — set or update scheduled_date for a carousel
router.patch("/schedule/:id", async (req, res) => {
  try {
    const { scheduled_date } = req.body;
    const carousel = await Carousel.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: { scheduled_date: scheduled_date || null } },
      { new: true },
    );
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });
    res.json(carousel);
  } catch (err) {
    logger.error("Failed to schedule carousel:", err);
    res.status(500).json({ error: "Failed to schedule carousel" });
  }
});

// GET /api/dashboard/analytics?client_id=xxx — performance analytics per client or across all
router.get("/analytics", async (req, res) => {
  try {
    const accountId = req.account._id;
    const filter = { account_id: accountId, status: "ready" };
    if (req.query.client_id) filter.client_id = req.query.client_id;

    const carousels = await Carousel.find(filter).sort({ created_at: -1 }).lean();
    const clients = await Client.find({ account_id: accountId }).lean();

    // Goal distribution
    const goalCounts = {};
    carousels.forEach((c) => {
      goalCounts[c.goal] = (goalCounts[c.goal] || 0) + 1;
    });

    // Confidence breakdown
    const confidenceScores = carousels.map((c) => c.confidence?.overall || 0);
    const avgConfidence = confidenceScores.length > 0
      ? Math.round(confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length)
      : 0;

    const confidenceBreakdown = {
      avg_overall: avgConfidence,
      avg_hook_strength: avg(carousels.map((c) => c.confidence?.hook_strength || 0)),
      avg_image_copy_fit: avg(carousels.map((c) => c.confidence?.image_copy_fit || 0)),
      avg_brand_fit: avg(carousels.map((c) => c.confidence?.brand_fit || 0)),
      avg_style_fit: avg(carousels.map((c) => c.confidence?.style_fit || 0)),
      avg_cta_fit: avg(carousels.map((c) => c.confidence?.cta_fit || 0)),
      avg_save_potential: avg(carousels.map((c) => c.confidence?.save_potential || 0)),
      avg_dm_potential: avg(carousels.map((c) => c.confidence?.dm_potential || 0)),
    };

    // Monthly trend (last 6 months)
    const monthlyTrend = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const y = d.getFullYear();
      const m = d.getMonth();
      const monthCarousels = carousels.filter((c) => {
        const cd = new Date(c.created_at);
        return cd.getFullYear() === y && cd.getMonth() === m;
      });
      monthlyTrend.push({
        month: `${y}-${String(m + 1).padStart(2, "0")}`,
        count: monthCarousels.length,
        avg_confidence: monthCarousels.length > 0
          ? Math.round(monthCarousels.reduce((sum, c) => sum + (c.confidence?.overall || 0), 0) / monthCarousels.length)
          : 0,
      });
    }

    // Per-client breakdown
    const clientBreakdown = clients.map((client) => {
      const cc = carousels.filter((c) => c.client_id.toString() === client._id.toString());
      return {
        _id: client._id,
        name: client.name,
        total: cc.length,
        avg_confidence: cc.length > 0
          ? Math.round(cc.reduce((sum, c) => sum + (c.confidence?.overall || 0), 0) / cc.length)
          : 0,
      };
    }).filter((c) => c.total > 0);

    // Top performing carousels
    const topCarousels = [...carousels]
      .sort((a, b) => (b.confidence?.overall || 0) - (a.confidence?.overall || 0))
      .slice(0, 5)
      .map((c) => ({
        _id: c._id,
        client_id: c.client_id,
        client_name: clients.find((cl) => cl._id.toString() === c.client_id.toString())?.name || "Unknown",
        goal: c.goal,
        confidence: c.confidence?.overall || 0,
        created_at: c.created_at,
      }));

    res.json({
      total_carousels: carousels.length,
      goal_distribution: goalCounts,
      confidence_breakdown: confidenceBreakdown,
      monthly_trend: monthlyTrend,
      client_breakdown: clientBreakdown,
      top_carousels: topCarousels,
    });
  } catch (err) {
    logger.error("Failed to get analytics:", err);
    res.status(500).json({ error: "Failed to get analytics" });
  }
});

function avg(arr) {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

module.exports = router;

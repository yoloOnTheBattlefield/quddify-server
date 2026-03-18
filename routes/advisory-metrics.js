const logger = require("../utils/logger").child({ module: "advisory-metrics" });
const express = require("express");
const AdvisoryMetric = require("../models/AdvisoryMetric");
const validate = require("../middleware/validate");
const { upsertMetricSchema } = require("../schemas/advisory-schemas");

const router = express.Router();

// GET /summary — aggregate across all clients for current month
router.get("/summary", async (req, res) => {
  try {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const filter = { account_id: req.account._id, month: currentMonth };

    const metrics = await AdvisoryMetric.find(filter).lean();

    let totalMrr = 0;
    let totalCashCollected = 0;
    let totalCallsBooked = 0;
    let totalCallsShowed = 0;
    let totalCallsClosed = 0;

    for (const m of metrics) {
      totalMrr += m.mrr || 0;
      totalCashCollected += m.cash_collected || 0;
      totalCallsBooked += m.calls_booked || 0;
      totalCallsShowed += m.calls_showed || 0;
      totalCallsClosed += m.calls_closed || 0;
    }

    res.json({
      month: currentMonth,
      total_mrr: totalMrr,
      total_cash_collected: totalCashCollected,
      avg_show_rate: totalCallsBooked > 0 ? totalCallsShowed / totalCallsBooked : 0,
      avg_close_rate: totalCallsShowed > 0 ? totalCallsClosed / totalCallsShowed : 0,
      client_count: metrics.length,
    });
  } catch (error) {
    logger.error("Advisory metrics summary error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET / — list metrics, filterable by client_id
router.get("/", async (req, res) => {
  try {
    const { client_id, page, limit } = req.query;
    const filter = { account_id: req.account._id };

    if (client_id) filter.client_id = client_id;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const [metrics, total] = await Promise.all([
      AdvisoryMetric.find(filter)
        .sort({ month: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      AdvisoryMetric.countDocuments(filter),
    ]);

    res.json({
      metrics,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    logger.error("List advisory metrics error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST / — upsert metric by { client_id, month }
router.post("/", validate(upsertMetricSchema), async (req, res) => {
  try {
    const { client_id, month, ...data } = req.body;

    const metric = await AdvisoryMetric.findOneAndUpdate(
      { client_id, month, account_id: req.account._id },
      { $set: { ...data, account_id: req.account._id } },
      { new: true, upsert: true },
    ).lean();

    res.status(200).json(metric);
  } catch (error) {
    logger.error("Upsert advisory metric error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:id — update specific metric fields
router.patch("/:id", async (req, res) => {
  try {
    const metric = await AdvisoryMetric.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      req.body,
      { new: true },
    ).lean();
    if (!metric) return res.status(404).json({ error: "Not found" });
    res.json(metric);
  } catch (error) {
    logger.error("Update advisory metric error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

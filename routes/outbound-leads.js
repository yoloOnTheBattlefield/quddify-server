const express = require("express");
const OutboundLead = require("../models/OutboundLead");

const router = express.Router();

// GET /outbound-leads — list with filters, search, pagination
router.get("/", async (req, res) => {
  const { source, qualified, isMessaged, replied, booked, search, promptId, promptLabel, page, limit } = req.query;
  const filter = {};

  if (source) filter.source = source;
  if (qualified !== undefined) filter.qualified = qualified === "true";
  if (isMessaged !== undefined) {
    filter.isMessaged = isMessaged === "true" ? true : { $ne: true };
  }
  if (replied !== undefined) filter.replied = replied === "true";
  if (booked !== undefined) filter.booked = booked === "true";
  if (promptId) filter.promptId = promptId;
  if (promptLabel) filter.promptLabel = { $regex: promptLabel, $options: "i" };
  if (search) {
    filter.$or = [
      { username: { $regex: search, $options: "i" } },
      { fullName: { $regex: search, $options: "i" } },
    ];
  }

  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 20;
  const skip = (pageNum - 1) * limitNum;

  const [leads, total] = await Promise.all([
    OutboundLead.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    OutboundLead.countDocuments(filter),
  ]);

  res.json({
    leads,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    },
  });
});

// GET /outbound-leads/stats — funnel counts
router.get("/stats", async (req, res) => {
  try {
    const [total, qualified, messaged, replied, booked, contractSum] = await Promise.all([
      OutboundLead.countDocuments({}),
      OutboundLead.countDocuments({ qualified: true }),
      OutboundLead.countDocuments({ isMessaged: true }),
      OutboundLead.countDocuments({ replied: true }),
      OutboundLead.countDocuments({ booked: true }),
      OutboundLead.aggregate([
        { $match: { contract_value: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: "$contract_value" }, count: { $sum: 1 } } },
      ]),
    ]);

    const contractData = contractSum[0] || { total: 0, count: 0 };

    res.json({
      total,
      qualified,
      messaged,
      replied,
      booked,
      contracts: contractData.count,
      contract_value: contractData.total,
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// GET /outbound-leads/:id
router.get("/:id", async (req, res) => {
  const lead = await OutboundLead.findById(req.params.id).lean();
  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
});

// PATCH /outbound-leads/:id
router.patch("/:id", async (req, res) => {
  const lead = await OutboundLead.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  }).lean();
  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
});

// DELETE /outbound-leads/:id
router.delete("/:id", async (req, res) => {
  await OutboundLead.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
});

module.exports = router;

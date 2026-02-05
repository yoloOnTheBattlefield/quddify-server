const express = require("express");
const Lead = require("../models/Lead");

const router = express.Router();

// get all leads (optionally filter by account_id/ghl, status, date range, search, and paginate)
router.get("/", async (req, res) => {
  const { account_id, ghl, status, start_date, end_date, search, page, limit } = req.query;
  const filter = {};
  if (ghl) filter.account_id = ghl;
  else if (account_id) filter.account_id = account_id;
  if (search) filter.first_name = { $regex: search, $options: "i" };
  if (status) {
    const statuses = Array.isArray(status) ? status : status.split(",");
    const statusConditions = statuses.map((s) => {
      const field = `${s}_at`;
      return { [field]: { $ne: null } };
    });
    filter.$or = statusConditions;
  }
  if (start_date || end_date) {
    filter.date_created = {};
    if (start_date) filter.date_created.$gte = `${start_date}T00:00:00.000Z`;
    if (end_date) filter.date_created.$lte = `${end_date}T23:59:59.999Z`;
  }

  // Pagination
  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 20;
  const skip = (pageNum - 1) * limitNum;

  const [leads, total] = await Promise.all([
    Lead.find(filter).sort({ date_created: -1 }).skip(skip).limit(limitNum).lean(),
    Lead.countDocuments(filter),
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

// get lead by id
router.get("/:id", async (req, res) => {
  const lead = await Lead.findById(req.params.id).lean();
  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
});

// create lead
router.post("/", async (req, res) => {
  const lead = await Lead.create(req.body);
  res.status(201).json(lead);
});

// update lead
router.patch("/:id", async (req, res) => {
  const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  }).lean();

  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
});

// delete lead
router.delete("/:id", async (req, res) => {
  await Lead.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
});

module.exports = router;

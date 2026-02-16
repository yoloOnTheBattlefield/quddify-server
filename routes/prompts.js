const express = require("express");
const Prompt = require("../models/Prompt");

const router = express.Router();

// GET /prompts
router.get("/", async (req, res) => {
  const { search, page, limit } = req.query;
  const filter = { account_id: req.account._id };
  if (search) filter.label = { $regex: search, $options: "i" };

  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 50;
  const skip = (pageNum - 1) * limitNum;

  const [prompts, total] = await Promise.all([
    Prompt.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
    Prompt.countDocuments(filter),
  ]);

  res.json({
    prompts,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    },
  });
});

// GET /prompts/:id
router.get("/:id", async (req, res) => {
  const prompt = await Prompt.findById(req.params.id).lean();
  if (!prompt) return res.status(404).json({ error: "Not found" });
  res.json(prompt);
});

// POST /prompts
router.post("/", async (req, res) => {
  const { label, promptText, isDefault, filters } = req.body;

  if (!label || !promptText) {
    return res
      .status(400)
      .json({ error: "label and promptText are required" });
  }

  const account_id = req.account._id;

  if (isDefault) {
    await Prompt.updateMany(
      { account_id, isDefault: true },
      { $set: { isDefault: false } },
    );
  }

  const data = {
    account_id,
    label,
    promptText,
    isDefault: isDefault || false,
  };
  if (filters) data.filters = filters;

  const prompt = await Prompt.create(data);
  res.status(201).json(prompt);
});

// PATCH /prompts/:id
router.patch("/:id", async (req, res) => {
  if (req.body.isDefault) {
    const existing = await Prompt.findById(req.params.id).lean();
    if (existing) {
      await Prompt.updateMany(
        { account_id: existing.account_id, isDefault: true, _id: { $ne: req.params.id } },
        { $set: { isDefault: false } },
      );
    }
  }

  const prompt = await Prompt.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  }).lean();
  if (!prompt) return res.status(404).json({ error: "Not found" });
  res.json(prompt);
});

// DELETE /prompts/:id
router.delete("/:id", async (req, res) => {
  await Prompt.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
});

module.exports = router;

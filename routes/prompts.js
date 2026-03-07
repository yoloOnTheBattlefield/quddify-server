const logger = require("../utils/logger").child({ module: "prompts" });
const express = require("express");
const Prompt = require("../models/Prompt");
const escapeRegex = require("../utils/escapeRegex");
const validate = require("../middleware/validate");
const { promptCreateSchema, promptUpdateSchema } = require("../schemas/prompts");

const router = express.Router();

// GET /prompts
router.get("/", async (req, res) => {
  try {
    const { search, page, limit } = req.query;
    const filter = { account_id: req.account._id };
    if (search) filter.label = { $regex: escapeRegex(search), $options: "i" };

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
  } catch (error) {
    logger.error("List prompts error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /prompts/:id
router.get("/:id", async (req, res) => {
  try {
    const prompt = await Prompt.findById(req.params.id).lean();
    if (!prompt) return res.status(404).json({ error: "Not found" });
    res.json(prompt);
  } catch (error) {
    logger.error("Get prompt error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /prompts
router.post("/", validate(promptCreateSchema), async (req, res) => {
  try {
    const { label, promptText, isDefault, filters } = req.body;

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
  } catch (error) {
    logger.error("Create prompt error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /prompts/:id
router.patch("/:id", validate(promptUpdateSchema), async (req, res) => {
  try {
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
  } catch (error) {
    logger.error("Update prompt error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /prompts/:id
router.delete("/:id", async (req, res) => {
  try {
    await Prompt.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (error) {
    logger.error("Delete prompt error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

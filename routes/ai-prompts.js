const logger = require("../utils/logger").child({ module: "ai-prompts" });
const express = require("express");
const AIPrompt = require("../models/AIPrompt");
const validate = require("../middleware/validate");
const { aiPromptCreateSchema, aiPromptUpdateSchema } = require("../schemas/ai-prompts");

const router = express.Router();

// GET /api/ai-prompts
router.get("/", async (req, res) => {
  try {
    const prompts = await AIPrompt.find({ account_id: req.account._id })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ prompts });
  } catch (error) {
    logger.error("List AI prompts error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/ai-prompts
router.post("/", validate(aiPromptCreateSchema), async (req, res) => {
  try {
    const { name, promptText } = req.body;
    const prompt = await AIPrompt.create({
      account_id: req.account._id,
      name,
      promptText,
    });
    res.status(201).json(prompt);
  } catch (error) {
    logger.error("Create AI prompt error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/ai-prompts/:id
router.patch("/:id", validate(aiPromptUpdateSchema), async (req, res) => {
  try {
    const prompt = await AIPrompt.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      req.body,
      { new: true },
    ).lean();
    if (!prompt) return res.status(404).json({ error: "Not found" });
    res.json(prompt);
  } catch (error) {
    logger.error("Update AI prompt error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/ai-prompts/:id
router.delete("/:id", async (req, res) => {
  try {
    await AIPrompt.findOneAndDelete({
      _id: req.params.id,
      account_id: req.account._id,
    });
    res.json({ deleted: true });
  } catch (error) {
    logger.error("Delete AI prompt error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

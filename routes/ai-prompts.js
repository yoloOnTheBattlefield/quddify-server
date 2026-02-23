const express = require("express");
const AIPrompt = require("../models/AIPrompt");

const router = express.Router();

// GET /api/ai-prompts
router.get("/", async (req, res) => {
  const prompts = await AIPrompt.find({ account_id: req.account._id })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ prompts });
});

// POST /api/ai-prompts
router.post("/", async (req, res) => {
  const { name, promptText } = req.body;
  if (!name || !promptText) {
    return res.status(400).json({ error: "name and promptText are required" });
  }
  const prompt = await AIPrompt.create({
    account_id: req.account._id,
    name,
    promptText,
  });
  res.status(201).json(prompt);
});

// PATCH /api/ai-prompts/:id
router.patch("/:id", async (req, res) => {
  const prompt = await AIPrompt.findOneAndUpdate(
    { _id: req.params.id, account_id: req.account._id },
    req.body,
    { new: true },
  ).lean();
  if (!prompt) return res.status(404).json({ error: "Not found" });
  res.json(prompt);
});

// DELETE /api/ai-prompts/:id
router.delete("/:id", async (req, res) => {
  await AIPrompt.findOneAndDelete({
    _id: req.params.id,
    account_id: req.account._id,
  });
  res.json({ deleted: true });
});

module.exports = router;

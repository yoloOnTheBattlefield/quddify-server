const express = require("express");
const router = express.Router();
const Client = require("../models/Client");
const validate = require("../middleware/validate");
const clientSchemas = require("../schemas/clients");
const logger = require("../utils/logger").child({ module: "clients" });

// GET /api/clients — list all clients for account
router.get("/", async (req, res) => {
  try {
    const clients = await Client.find({ account_id: req.account._id }).sort({ created_at: -1 });
    res.json(clients);
  } catch (err) {
    logger.error("Failed to list clients:", err);
    res.status(500).json({ error: "Failed to list clients" });
  }
});

// GET /api/clients/:id
router.get("/:id", async (req, res) => {
  try {
    const client = await Client.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!client) return res.status(404).json({ error: "Client not found" });
    res.json(client);
  } catch (err) {
    logger.error("Failed to get client:", err);
    res.status(500).json({ error: "Failed to get client" });
  }
});

// POST /api/clients
router.post("/", validate(clientSchemas.create), async (req, res) => {
  try {
    const client = await Client.create({ ...req.body, account_id: req.account._id });
    // Auto-generate niche playbook in background
    if (client.niche) {
      const { generateNichePlaybook } = require("../services/carousel/nichePlaybookGenerator");
      generateNichePlaybook(client._id.toString(), req.account._id.toString()).catch((err) => {
        logger.error("Background niche playbook generation failed:", err);
      });
    }
    res.status(201).json(client);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "Client slug already exists" });
    logger.error("Failed to create client:", err);
    res.status(500).json({ error: "Failed to create client" });
  }
});

// PATCH /api/clients/:id
router.patch("/:id", validate(clientSchemas.update), async (req, res) => {
  try {
    // Build update with dot notation for nested objects so partial updates work
    const update = {};
    const { brand_kit, voice_profile, cta_defaults, ...topLevel } = req.body;
    Object.assign(update, topLevel);
    if (brand_kit) {
      for (const [k, v] of Object.entries(brand_kit)) {
        update[`brand_kit.${k}`] = v;
      }
    }
    if (voice_profile) {
      for (const [k, v] of Object.entries(voice_profile)) {
        update[`voice_profile.${k}`] = v;
      }
    }
    if (cta_defaults) {
      for (const [k, v] of Object.entries(cta_defaults)) {
        update[`cta_defaults.${k}`] = v;
      }
    }

    const client = await Client.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: update },
      { new: true },
    );
    if (!client) return res.status(404).json({ error: "Client not found" });
    res.json(client);
  } catch (err) {
    logger.error("Failed to update client:", err);
    res.status(500).json({ error: "Failed to update client" });
  }
});

// POST /api/clients/:id/generate-niche-playbook — generate niche-specific playbook via GPT
router.post("/:id/generate-niche-playbook", async (req, res) => {
  try {
    const client = await Client.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!client) return res.status(404).json({ error: "Client not found" });
    const { generateNichePlaybook } = require("../services/carousel/nichePlaybookGenerator");
    const playbook = await generateNichePlaybook(client._id.toString(), req.account._id.toString());
    res.json({ success: true, niche_playbook: playbook });
  } catch (err) {
    logger.error("Failed to generate niche playbook:", err);
    res.status(500).json({ error: "Failed to generate niche playbook" });
  }
});

// DELETE /api/clients/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await Client.findOneAndDelete({ _id: req.params.id, account_id: req.account._id });
    if (!result) return res.status(404).json({ error: "Client not found" });
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete client:", err);
    res.status(500).json({ error: "Failed to delete client" });
  }
});

module.exports = router;

const express = require("express");
const router = express.Router();
const Client = require("../models/Client");
const validate = require("../middleware/validate");
const clientSchemas = require("../schemas/clients");
const logger = require("../utils/logger").child({ module: "clients" });

function sanitizeIgOAuth(client) {
  const obj = client.toObject ? client.toObject() : { ...client };
  if (obj.ig_oauth) {
    obj.ig_oauth = {
      ig_user_id: obj.ig_oauth.ig_user_id || null,
      ig_username: obj.ig_oauth.ig_username || null,
      connected_at: obj.ig_oauth.connected_at || null,
    };
  }
  return obj;
}

// GET /api/clients — list all clients for account
router.get("/", async (req, res) => {
  try {
    const clients = await Client.find({ account_id: req.account._id }).sort({ created_at: -1 });
    res.json(clients.map(sanitizeIgOAuth));
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
    res.json(sanitizeIgOAuth(client));
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

// POST /api/clients/:id/clone-settings-from/:sourceId — copy brand kit, voice profile, CTA defaults from another client
router.post("/:id/clone-settings-from/:sourceId", async (req, res) => {
  try {
    const [target, source] = await Promise.all([
      Client.findOne({ _id: req.params.id, account_id: req.account._id }),
      Client.findOne({ _id: req.params.sourceId, account_id: req.account._id }),
    ]);
    if (!target) return res.status(404).json({ error: "Target client not found" });
    if (!source) return res.status(404).json({ error: "Source client not found" });

    const fields = req.body.fields || ["brand_kit", "voice_profile", "cta_defaults"];
    const update = {};
    for (const field of fields) {
      if (["brand_kit", "voice_profile", "cta_defaults"].includes(field) && source[field]) {
        update[field] = source[field].toObject ? source[field].toObject() : source[field];
      }
    }

    const updated = await Client.findByIdAndUpdate(target._id, { $set: update }, { new: true });
    res.json(updated);
  } catch (err) {
    logger.error("Failed to clone client settings:", err);
    res.status(500).json({ error: "Failed to clone client settings" });
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

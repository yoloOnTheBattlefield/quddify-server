const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Client = require("../models/Client");
const User = require("../models/User");
const Account = require("../models/Account");
const AccountUser = require("../models/AccountUser");
const validate = require("../middleware/validate");
const clientSchemas = require("../schemas/clients");
const logger = require("../utils/logger").child({ module: "clients" });
const { buildClientCollectionFilter, loadOwnedClient } = require("../utils/clientUserScope");

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

// GET /api/clients — list all clients for account (role 2 only sees own client)
router.get("/", async (req, res) => {
  try {
    // Client users live in their own isolated Account, but their Client doc
    // lives in the creator's account. The helper detects this and scopes by
    // user_id instead of account_id.
    const filter = await buildClientCollectionFilter(req);
    const clients = await Client.find(filter).sort({ created_at: -1 });
    res.json(clients.map(sanitizeIgOAuth));
  } catch (err) {
    logger.error("Failed to list clients:", err);
    res.status(500).json({ error: "Failed to list clients" });
  }
});

// GET /api/clients/:id
router.get("/:id", async (req, res) => {
  try {
    const filter = { _id: req.params.id, ...(await buildClientCollectionFilter(req)) };
    const client = await Client.findOne(filter);
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
    const { email, password, ...clientData } = req.body;

    // Auto-generate slug from name
    const slug = clientData.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    let userId = null;

    // Create a user account for the client if email/password provided
    if (email && password) {
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) return res.status(409).json({ error: "A user with this email already exists" });

      // Provision a DEDICATED Account for the client user so their login is
      // isolated from the creator's tenant. Previously the client user was
      // added as a member of the creator's account, which caused them to see
      // all of the creator's data (bookings, leads, analytics, etc.) because
      // the data routes only filter by account_id.
      const clientAccount = await Account.create({ name: clientData.name });

      const hashed = await bcrypt.hash(password, 10);
      const user = await User.create({
        email: email.toLowerCase(),
        password: hashed,
        first_name: clientData.name.split(/\s+/)[0] || clientData.name,
        last_name: clientData.name.split(/\s+/).slice(1).join(" ") || "",
        account_id: clientAccount._id,
      });
      userId = user._id;

      // Bind the client user to their OWN account, not the creator's.
      await AccountUser.create({
        user_id: user._id,
        account_id: clientAccount._id,
        role: 1, // owner of their own isolated account
        is_default: true,
      });
    }

    // NOTE: the Client document stays in the creator's account so the creator
    // can continue to manage it. The client user's login lives in a separate
    // account and cannot see the creator's data.
    const client = await Client.create({
      ...clientData,
      slug,
      email: email ? email.toLowerCase() : null,
      user_id: userId,
      account_id: req.account._id,
    });

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
    const { brand_kit, voice_profile, cta_defaults, ai_integrations, ...topLevel } = req.body;
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
    if (ai_integrations) {
      const { encrypt } = require("../utils/crypto");
      for (const [k, v] of Object.entries(ai_integrations)) {
        update[`ai_integrations.${k}`] = v ? encrypt(v) : null;
      }
    }

    const target = await loadOwnedClient(req, req.params.id);
    if (!target) return res.status(404).json({ error: "Client not found" });
    const client = await Client.findByIdAndUpdate(target._id, { $set: update }, { new: true });
    res.json(client);
  } catch (err) {
    logger.error("Failed to update client:", err);
    res.status(500).json({ error: "Failed to update client" });
  }
});

// POST /api/clients/:id/upload-profile-picture — upload or download-from-URL a profile picture
const multer = require("multer");
const pfpUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post("/:id/upload-profile-picture", pfpUpload.single("image"), async (req, res) => {
  try {
    const client = await loadOwnedClient(req, req.params.id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const { upload: s3Upload } = require("../services/storageService");
    let buffer, contentType;

    if (req.file) {
      // Direct file upload
      buffer = req.file.buffer;
      contentType = req.file.mimetype;
    } else if (req.body.url) {
      // Download from URL
      const response = await fetch(req.body.url);
      if (!response.ok) return res.status(400).json({ error: "Failed to fetch image from URL" });
      contentType = response.headers.get("content-type") || "image/jpeg";
      buffer = Buffer.from(await response.arrayBuffer());
    } else {
      return res.status(400).json({ error: "Provide an image file or a url" });
    }

    const key = `clients/${client._id}/profile-picture.jpg`;
    await s3Upload(key, buffer, contentType);

    const updated = await Client.findByIdAndUpdate(
      client._id,
      { $set: { ig_profile_picture_url: `/uploads/${key}` } },
      { new: true },
    );
    res.json({ ig_profile_picture_url: updated.ig_profile_picture_url });
  } catch (err) {
    logger.error("Failed to upload profile picture:", err);
    res.status(500).json({ error: "Failed to upload profile picture" });
  }
});

// POST /api/clients/:id/generate-niche-playbook — generate niche-specific playbook via GPT
router.post("/:id/generate-niche-playbook", async (req, res) => {
  try {
    const client = await loadOwnedClient(req, req.params.id);
    if (!client) return res.status(404).json({ error: "Client not found" });
    const { generateNichePlaybook } = require("../services/carousel/nichePlaybookGenerator");
    const playbook = await generateNichePlaybook(client._id.toString(), client.account_id.toString());
    res.json({ success: true, niche_playbook: playbook });
  } catch (err) {
    logger.error("Failed to generate niche playbook:", err);
    res.status(500).json({ error: "Failed to generate niche playbook" });
  }
});

// POST /api/clients/:id/generate-voice-profile — analyze a YT transcript and generate a voice profile
router.post("/:id/generate-voice-profile", async (req, res) => {
  try {
    const client = await loadOwnedClient(req, req.params.id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const { transcript } = req.body;
    if (!transcript || typeof transcript !== "string" || transcript.trim().length < 50) {
      return res.status(400).json({ error: "Transcript must be at least 50 characters" });
    }

    const Anthropic = require("@anthropic-ai/sdk").default;
    const Account = require("../models/Account");
    // Always read the Claude key from the Client's owning account, not
    // req.account (which for role=2 is the user's empty isolated account).
    const account = await Account.findById(client.account_id);
    const token = account?.claude_token
      ? Account.decryptField(account.claude_token)
      : process.env.CLAUDE;
    if (!token) return res.status(400).json({ error: "No Claude API key configured" });

    const claude = new Anthropic({ apiKey: token });

    const message = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are a brand voice analyst. Analyze this YouTube transcript and produce a concise brand voice profile that a copywriter (or AI) can use to write carousel copy that sounds exactly like this person.

Focus on:
- Tone (e.g. confident, casual, provocative, empathetic)
- Sentence structure (short/punchy vs long/flowing, fragments, rhetorical questions)
- Vocabulary level and favorite words/phrases
- How they open and close points
- Emotional patterns (when do they get intense, softer, humorous)
- Any verbal tics or signature expressions
- How they address the audience

Return ONLY the voice profile text — no headings, no preamble, no markdown formatting. Just a natural-language description a writer can reference.

TRANSCRIPT:
${transcript.slice(0, 30000)}`,
        },
      ],
    });

    const voiceText = message.content[0]?.text || "";

    await Client.findByIdAndUpdate(client._id, {
      $set: { "voice_profile.raw_text": voiceText },
    });

    res.json({ voice_profile: { raw_text: voiceText } });
  } catch (err) {
    logger.error("Failed to generate voice profile:", err);
    res.status(500).json({ error: "Failed to generate voice profile" });
  }
});

// POST /api/clients/:id/clone-settings-from/:sourceId — copy brand kit, voice profile, CTA defaults from another client
router.post("/:id/clone-settings-from/:sourceId", async (req, res) => {
  try {
    const [target, source] = await Promise.all([
      loadOwnedClient(req, req.params.id),
      loadOwnedClient(req, req.params.sourceId),
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
    const target = await loadOwnedClient(req, req.params.id);
    if (!target) return res.status(404).json({ error: "Client not found" });
    await Client.deleteOne({ _id: target._id });
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete client:", err);
    res.status(500).json({ error: "Failed to delete client" });
  }
});

module.exports = router;

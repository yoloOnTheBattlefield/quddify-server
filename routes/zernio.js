const logger = require("../utils/logger").child({ module: "zernio" });
const express = require("express");
const crypto = require("crypto");

const Account = require("../models/Account");
const { encrypt, decrypt } = require("../utils/crypto");
const zernioClient = require("../services/zernioClient");
const validate = require("../middleware/validate");
const {
  listProfilesSchema,
  listAccountsSchema,
  connectSchema,
  emptySchema,
} = require("../schemas/zernio");

const router = express.Router();

/**
 * The key may come from the request (during setup, before anything is saved) or
 * from the stored connection (for an already-connected account). It is never
 * echoed back to the client.
 */
async function resolveApiKey(req) {
  if (req.body?.api_key) return req.body.api_key;
  const account = await Account.findById(req.account._id).select("zernio.api_key").lean();
  return decrypt(account?.zernio?.api_key) || null;
}

function publicUrlFor(req, accountId) {
  const base =
    process.env.PUBLIC_SERVER_URL ||
    process.env.SERVER_URL ||
    `${req.protocol}://${req.get("host")}`;
  return new URL(`/zernio-webhook/${accountId}`, base).toString();
}

function sendZernioError(res, err, fallback) {
  if (err instanceof zernioClient.ZernioApiError) {
    return res.status(err.status === 429 ? 429 : 502).json({ error: err.message });
  }
  logger.error(`[zernio] ${fallback}:`, err);
  return res.status(500).json({ error: fallback });
}

// ─── GET /api/zernio/status ─────────────────────────────────────────────────
router.get("/status", async (req, res) => {
  try {
    const account = await Account.findById(req.account._id).select("zernio").lean();
    const z = account?.zernio;

    res.json({
      connected: !!z?.enabled,
      // Never return the key itself — only whether one is stored.
      has_api_key: !!z?.api_key,
      profile_id: z?.profile_id || null,
      ig_user_id: z?.ig_user_id || null,
      ig_username: z?.ig_username || null,
      webhook_url: publicUrlFor(req, req.account._id),
      webhook_registered: !!z?.webhook_id,
      connected_at: z?.connected_at || null,
    });
  } catch (err) {
    logger.error("[zernio] status error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/zernio/profiles — list Zernio profiles for a key ─────────────
router.post("/profiles", validate(listProfilesSchema), async (req, res) => {
  try {
    const apiKey = await resolveApiKey(req);
    if (!apiKey) return res.status(400).json({ error: "No Zernio API key provided" });

    res.json({ profiles: await zernioClient.listProfiles(apiKey) });
  } catch (err) {
    sendZernioError(res, err, "Could not list Zernio profiles");
  }
});

// ─── POST /api/zernio/accounts — list Instagram accounts on a profile ───────
router.post("/accounts", validate(listAccountsSchema), async (req, res) => {
  try {
    const apiKey = await resolveApiKey(req);
    if (!apiKey) return res.status(400).json({ error: "No Zernio API key provided" });

    const accounts = await zernioClient.listInstagramAccounts({
      apiKey,
      profileId: req.body.profile_id,
    });
    res.json({ accounts });
  } catch (err) {
    sendZernioError(res, err, "Could not list Instagram accounts");
  }
});

// ─── POST /api/zernio/connect ───────────────────────────────────────────────
router.post("/connect", validate(connectSchema), async (req, res) => {
  try {
    const apiKey = await resolveApiKey(req);
    if (!apiKey) return res.status(400).json({ error: "No Zernio API key provided" });

    const existing = await Account.findById(req.account._id)
      .select("zernio.webhook_id zernio.webhook_secret")
      .lean();

    // Reuse the existing secret so a reconnect doesn't invalidate in-flight
    // events; mint one on first connect.
    const secret =
      decrypt(existing?.zernio?.webhook_secret) || crypto.randomBytes(32).toString("hex");

    const webhookId = await zernioClient.ensureWebhook({
      apiKey,
      url: publicUrlFor(req, req.account._id),
      secret,
      webhookId: existing?.zernio?.webhook_id || null,
    });

    await Account.findByIdAndUpdate(req.account._id, {
      $set: {
        "zernio.api_key": encrypt(apiKey),
        "zernio.profile_id": req.body.profile_id,
        "zernio.zernio_account_id": req.body.zernio_account_id,
        "zernio.ig_user_id": req.body.ig_user_id,
        "zernio.ig_username": req.body.ig_username || null,
        "zernio.webhook_id": webhookId,
        "zernio.webhook_secret": encrypt(secret),
        "zernio.enabled": true,
        "zernio.connected_at": new Date(),
      },
    });

    logger.info(
      `[zernio] Connected account ${req.account._id} to IG ${req.body.ig_user_id} via Zernio`,
    );
    res.json({ success: true, webhook_registered: !!webhookId });
  } catch (err) {
    sendZernioError(res, err, "Could not connect Zernio");
  }
});

// ─── DELETE /api/zernio/disconnect ──────────────────────────────────────────
router.delete("/", validate(emptySchema), async (req, res) => {
  try {
    // Leaves the webhook registered upstream on purpose: deleting it would
    // break any other integration pointed at the same Zernio account. Disabling
    // the connection here stops us acting on the events.
    await Account.findByIdAndUpdate(req.account._id, {
      $set: {
        "zernio.api_key": null,
        "zernio.profile_id": null,
        "zernio.zernio_account_id": null,
        "zernio.ig_user_id": null,
        "zernio.ig_username": null,
        "zernio.webhook_secret": null,
        "zernio.enabled": false,
        "zernio.connected_at": null,
      },
    });

    logger.info(`[zernio] Disconnected account ${req.account._id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error("[zernio] disconnect error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

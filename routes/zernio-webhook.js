const logger = require("../utils/logger").child({ module: "zernio-webhook" });
const express = require("express");
const mongoose = require("mongoose");

const Account = require("../models/Account");
const { decrypt } = require("../utils/crypto");
const { verifyZernioSignature, normalizeZernioEvent } = require("../services/zernioEvent");
const { processWebhookEvent } = require("./instagram-webhook");

const router = express.Router();

// ─── POST /zernio-webhook/:accountId — receive Zernio events ─────────────────
//
// Mounted before express.json() with a rawBody verify hook, because the HMAC is
// computed over the exact bytes Zernio sent.
router.post("/:accountId", async (req, res) => {
  const { accountId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(accountId)) {
    return res.status(404).json({ error: "Unknown account" });
  }

  const account = await Account.findById(accountId).select("zernio").lean();
  const connection = account?.zernio;

  if (!connection?.enabled || !connection.webhook_secret) {
    logger.warn(`[zernio-webhook] No active Zernio connection for account ${accountId}`);
    return res.status(404).json({ error: "Unknown account" });
  }

  const signature = req.headers["x-zernio-signature"];
  const valid = verifyZernioSignature({
    rawBody: req.rawBody,
    signature: Array.isArray(signature) ? signature[0] : signature,
    secret: decrypt(connection.webhook_secret),
  });

  if (!valid) {
    logger.warn(`[zernio-webhook] Invalid signature for account ${accountId}`);
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Acknowledge before doing any work — Zernio retries on non-2xx.
  res.status(200).json({ status: "ok" });

  const normalized = normalizeZernioEvent({
    payload: req.body,
    account: {
      zernio_account_id: connection.zernio_account_id,
      ig_user_id: connection.ig_user_id,
    },
  });

  if (!normalized) {
    logger.info(`[zernio-webhook] Ignored event for account ${accountId}`);
    return;
  }

  processWebhookEvent(normalized).catch((err) => {
    logger.error("[zernio-webhook] Processing error:", err);
  });
});

module.exports = router;

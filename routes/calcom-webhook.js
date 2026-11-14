const logger = require("../utils/logger").child({ module: "calcom-webhook" });
const express = require("express");
const mongoose = require("mongoose");

const Account = require("../models/Account");
const { decrypt } = require("../utils/crypto");
const { verifyCalcomSignature, handleCalcomEvent } = require("../services/calcomBooking");
const { resolveContact, applyStageDates } = require("./agent");

const router = express.Router();

// ─── POST /calcom-webhook/:accountId — receive Cal.com booking events ────────
//
// Mounted before express.json() with a rawBody verify hook: the HMAC covers the
// exact bytes Cal.com sent. Registered per event type by scripts/calcom-connect.js.
router.post("/:accountId", async (req, res) => {
  const { accountId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(accountId)) return res.status(404).json({ error: "Unknown account" });

  const account = await Account.findById(accountId).lean();
  const connection = account?.calcom;
  if (!connection?.enabled || !connection.webhook_secret) {
    logger.warn(`[calcom-webhook] No active Cal.com connection for account ${accountId}`);
    return res.status(404).json({ error: "Unknown account" });
  }

  const signature = req.headers["x-cal-signature-256"];
  const valid = verifyCalcomSignature({
    rawBody: req.rawBody,
    signature: Array.isArray(signature) ? signature[0] : signature,
    secret: decrypt(connection.webhook_secret),
  });
  if (!valid) {
    logger.warn(`[calcom-webhook] Invalid signature for account ${accountId}`);
    return res.status(401).json({ error: "Invalid signature" });
  }

  const trigger = req.body?.triggerEvent;
  if (!trigger || String(trigger).toUpperCase() === "PING") return res.status(200).json({ status: "ok" });

  try {
    const result = await handleCalcomEvent(account, trigger, req.body.payload, { resolveContact, applyStageDates });
    logger.info({ trigger, ...result }, "[calcom-webhook] handled");
    res.status(200).json({ status: "ok", ...result });
  } catch (err) {
    logger.error("[calcom-webhook] Processing error:", err);
    // non-2xx makes Cal.com retry
    res.status(500).json({ error: "Processing failed" });
  }
});

module.exports = router;

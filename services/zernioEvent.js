const { createHmac, timingSafeEqual } = require("crypto");

/**
 * Zernio signs webhooks with HMAC-SHA256 over the raw request body, hex encoded,
 * in the `x-zernio-signature` header.
 */
function verifyZernioSignature({ rawBody, signature, secret }) {
  if (!signature || !secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;

  const expected = createHmac("sha256", secret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "", "utf8"))
    .digest();
  const received = Buffer.from(signature, "hex");

  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Converts a Zernio event envelope into the Meta webhook shape our Instagram
 * webhook already speaks, so comment automation and the DM inbox need no
 * provider-specific handling downstream.
 *
 * Returns null when the payload is malformed, belongs to a different Zernio
 * account, or carries an event we don't act on.
 */
function normalizeZernioEvent({ payload, account }) {
  if (!payload || typeof payload !== "object") return null;
  if (!account?.ig_user_id) return null;

  const { event, comment, message, conversation, metadata, statusAt } = payload;
  if (!isNonEmptyString(payload.id) || !isNonEmptyString(event)) return null;
  if (payload.account?.platform !== "instagram") return null;

  // Only accept events for the Zernio account this CRM account is bound to.
  if (!isNonEmptyString(payload.account?.id)) return null;
  if (payload.account.id !== account.zernio_account_id) return null;

  const entry = { id: account.ig_user_id, time: Date.now() };

  if (event === "comment.received") {
    if (!comment || !isNonEmptyString(comment.id) || !isNonEmptyString(comment.platformPostId)) {
      return null;
    }
    if (!isNonEmptyString(comment.author?.id)) return null;

    entry.changes = [
      {
        field: "comments",
        value: {
          id: comment.id,
          text: typeof comment.text === "string" ? comment.text : "",
          from: { id: comment.author.id, username: comment.author.username },
          media: { id: comment.platformPostId },
        },
      },
    ];
  } else if (event === "message.received") {
    // Outgoing messages echo back too; the inbox only records inbound here.
    if (!message || message.direction !== "incoming") return null;
    if (!isNonEmptyString(message.platformMessageId)) return null;
    if (!isNonEmptyString(message.sender?.id)) return null;

    entry.messaging = [
      {
        sender: { id: message.sender.id },
        recipient: { id: account.ig_user_id },
        timestamp: Date.now(),
        message: { mid: message.platformMessageId, text: message.text ?? "" },
        ...(metadata?.postbackPayload
          ? { postback: { payload: metadata.postbackPayload, title: metadata.postbackTitle } }
          : {}),
      },
    ];
  } else if (event === "message.read") {
    if (!isNonEmptyString(conversation?.participantId)) return null;

    const watermark = statusAt ? Date.parse(statusAt) : Date.now();
    entry.messaging = [
      {
        sender: { id: conversation.participantId },
        recipient: { id: account.ig_user_id },
        timestamp: Date.now(),
        read: { watermark: Number.isFinite(watermark) ? watermark : Date.now() },
      },
    ];
  } else {
    return null;
  }

  return { object: "instagram", entry: [entry] };
}

module.exports = { verifyZernioSignature, normalizeZernioEvent };

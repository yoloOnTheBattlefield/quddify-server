const crypto = require("crypto");
const logger = require("../utils/logger").child({ module: "zernioClient" });

const BASE_URL = "https://zernio.com/api/v1";
const TIMEOUT_MS = 30_000;

// Events we ask Zernio to deliver. `comment.received` drives comment
// automation; the message events keep the DM inbox in sync.
const WEBHOOK_EVENTS = ["comment.received", "message.received", "message.read"];

class ZernioApiError extends Error {
  constructor(status, message) {
    super(message || `Zernio request failed (HTTP ${status})`);
    this.name = "ZernioApiError";
    this.status = status;
  }
}

/**
 * Zernio responses can carry platform credentials, so only the HTTP status is
 * ever surfaced — never the response body, in logs or to the client.
 */
function classify(status) {
  if (status === 401) return new ZernioApiError(401, "The Zernio API key is invalid or expired.");
  if (status === 402) return new ZernioApiError(402, "This Zernio account needs Inbox access. Check your Zernio plan.");
  if (status === 403)
    return new ZernioApiError(
      403,
      "Use an unrestricted, read-write Zernio key with access to this profile and Inbox.",
    );
  if (status === 429) return new ZernioApiError(429, "Zernio rate limit reached. Retry shortly.");
  return new ZernioApiError(status);
}

async function zernioRequest({ apiKey, path, method = "GET", body, idempotencyKey }) {
  if (!apiKey) throw new ZernioApiError(401, "No Zernio API key configured.");
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid Zernio API path");

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ZernioApiError(502, "Could not reach Zernio.");
  }

  if (!response.ok) {
    logger.warn(`[zernio] ${method} ${path} -> HTTP ${response.status}`);
    throw classify(response.status);
  }

  if (response.status === 204) return undefined;

  try {
    return await response.json();
  } catch {
    throw new ZernioApiError(502, "Unexpected Zernio response.");
  }
}

// ─── Discovery ───────────────────────────────────────────────────────────────

async function listProfiles(apiKey) {
  const data = await zernioRequest({ apiKey, path: "/profiles" });
  return (data?.profiles || []).map((p) => ({ id: p._id, name: p.name }));
}

async function listInstagramAccounts({ apiKey, profileId }) {
  const data = await zernioRequest({
    apiKey,
    path: `/accounts?profileId=${encodeURIComponent(profileId)}&platform=instagram`,
  });

  return (data?.accounts || [])
    .filter((a) => {
      if (a.platform !== "instagram") return false;
      if (a.isActive === false) return false;
      if (!a.platformUserId) return false;
      const owner = typeof a.profileId === "string" ? a.profileId : a.profileId?._id;
      return owner === profileId;
    })
    .map((a) => ({
      id: a._id,
      ig_user_id: a.platformUserId,
      username: a.username,
      name: a.displayName ?? null,
    }));
}

// ─── Webhook registration ────────────────────────────────────────────────────

async function listWebhooks(apiKey) {
  const data = await zernioRequest({ apiKey, path: "/webhooks/settings" });
  return data?.webhooks || [];
}

/**
 * Creates or updates the webhook Zernio posts events to. Matches on the stored
 * webhook id first, then on the URL, so re-connecting doesn't pile up
 * duplicates. Returns the webhook id to persist.
 */
async function ensureWebhook({ apiKey, url, secret, webhookId }) {
  const webhooks = await listWebhooks(apiKey);
  const existing =
    webhooks.find((w) => w._id === webhookId) || webhooks.find((w) => w.url === url);

  const body = {
    name: "Quddify",
    url,
    secret,
    events: WEBHOOK_EVENTS,
    isActive: true,
  };

  if (existing) {
    await zernioRequest({
      apiKey,
      path: "/webhooks/settings",
      method: "PUT",
      body: { ...body, _id: existing._id },
    });
    return existing._id;
  }

  const result = await zernioRequest({
    apiKey,
    path: "/webhooks/settings",
    method: "POST",
    body,
  });
  return result?.webhook?._id || null;
}

// ─── Sending ─────────────────────────────────────────────────────────────────

function idempotencyKeyFor(parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Private reply to a comment — the Zernio equivalent of Meta's
 * POST /{ig_user_id}/messages with recipient: { comment_id }.
 */
async function sendPrivateReply({ apiKey, zernioAccountId, postId, commentId, message }) {
  return zernioRequest({
    apiKey,
    method: "POST",
    path: `/inbox/comments/${encodeURIComponent(postId || commentId)}/${encodeURIComponent(commentId)}/private-reply`,
    body: { accountId: zernioAccountId, message },
  });
}

/** Public reply on the comment thread. */
async function sendPublicReply({ apiKey, zernioAccountId, postId, commentId, message }) {
  return zernioRequest({
    apiKey,
    method: "POST",
    path: `/inbox/comments/${encodeURIComponent(postId || commentId)}`,
    body: { accountId: zernioAccountId, commentId, message },
  });
}

/** Ordinary DM to a known participant. */
async function sendDirectMessage({ apiKey, zernioAccountId, recipientId, message, operationId }) {
  return zernioRequest({
    apiKey,
    method: "POST",
    path: `/inbox/conversations/${encodeURIComponent(recipientId)}/messages`,
    body: { accountId: zernioAccountId, message },
    idempotencyKey: operationId
      ? idempotencyKeyFor([operationId, recipientId, message])
      : undefined,
  });
}

module.exports = {
  BASE_URL,
  WEBHOOK_EVENTS,
  ZernioApiError,
  zernioRequest,
  listProfiles,
  listInstagramAccounts,
  listWebhooks,
  ensureWebhook,
  sendPrivateReply,
  sendPublicReply,
  sendDirectMessage,
};

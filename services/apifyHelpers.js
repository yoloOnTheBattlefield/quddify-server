const logger = require("../utils/logger").child({ module: "apifyHelpers" });
const ApifyToken = require("../models/ApifyToken");

// Apify actor IDs
const REEL_SCRAPER = "apify~instagram-reel-scraper";
const POST_SCRAPER = "apify~instagram-post-scraper";
const COMMENT_SCRAPER = "SbK00X0JYCPblD2wp";
const PROFILE_SCRAPER = "dSCLg0C3YEZ83HzYX";
const LIKER_SCRAPER = "datadoping~instagram-likes-scraper";
const FOLLOWERS_SCRAPER = "scraping_solutions~instagram-scraper-followers-following-no-cookies";

const APIFY_BASE = "https://api.apify.com/v2";
const APIFY_MEMORY_MB = 4096;
const APIFY_MAX_CHARGE_USD = 10;

class ApifyLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApifyLimitError";
  }
}

async function startApifyRun(actorId, input, token) {
  const qs = `memory=${APIFY_MEMORY_MB}&maxTotalChargeUsd=${APIFY_MAX_CHARGE_USD}`;
  const res = await fetch(`${APIFY_BASE}/acts/${actorId}/runs?${qs}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      throw new ApifyLimitError(`Apify ${res.status}: ${text}`);
    }
    if (/monthly-usage-hard-limit|usage-limit-exceeded|insufficient-credits/i.test(text)) {
      throw new ApifyLimitError(`Apify ${res.status}: ${text}`);
    }
    throw new Error(`Apify start failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.data;
}

async function pickApifyToken(accountId, legacyToken) {
  const tokens = await ApifyToken.find({
    account_id: accountId,
    status: "active",
  })
    .sort({ last_used_at: 1 })
    .lean();

  if (tokens.length > 0) {
    const picked = tokens[0];
    await ApifyToken.updateOne(
      { _id: picked._id },
      { $set: { last_used_at: new Date() }, $inc: { usage_count: 1 } },
    );
    return { tokenValue: picked.token, tokenDocId: picked._id.toString() };
  }

  if (legacyToken) {
    return { tokenValue: legacyToken, tokenDocId: null };
  }

  return null;
}

async function markTokenLimitReached(tokenDocId, errorMsg) {
  if (!tokenDocId) return;
  await ApifyToken.updateOne(
    { _id: tokenDocId },
    { $set: { status: "limit_reached", last_error: errorMsg } },
  );
}

async function fetchApifyUsage(token) {
  try {
    const res = await fetch(`${APIFY_BASE}/users/me/limits`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    return {
      usedUsd: data.current?.monthlyUsageUsd ?? null,
      limitUsd: data.limits?.maxMonthlyUsageUsd ?? null,
      resetAt: data.monthlyUsageCycle?.endAt ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Start an Apify run with automatic token rotation on limit errors.
 * @param {string} actorId
 * @param {Object} input
 * @param {string} accountId
 * @param {string|null} legacyToken - fallback token from Account doc
 * @param {Function} [onLog] - optional (message, level) => void for logging
 * @returns {{ run, tokenValue, tokenDocId }}
 */
async function startApifyRunWithRotation(actorId, input, accountId, legacyToken, onLog) {
  const MAX_ROTATIONS = 10;
  for (let attempt = 0; attempt < MAX_ROTATIONS; attempt++) {
    const picked = await pickApifyToken(accountId, legacyToken);
    if (!picked) {
      throw new ApifyLimitError("No active Apify tokens available");
    }

    const masked = picked.tokenValue.slice(0, 6) + "…" + picked.tokenValue.slice(-4);
    const usage = await fetchApifyUsage(picked.tokenValue);
    let tokenMsg = `Using token ${masked}${picked.tokenDocId ? ` (${picked.tokenDocId})` : " (legacy)"}`;
    if (usage) {
      const spent = usage.usedUsd != null ? `$${usage.usedUsd.toFixed(2)}` : "?";
      const limit = usage.limitUsd != null ? `$${usage.limitUsd.toFixed(2)}` : "?";
      const reset = usage.resetAt ? new Date(usage.resetAt).toLocaleDateString() : "?";
      tokenMsg += ` — usage: ${spent}/${limit}, resets ${reset}`;
    }
    if (onLog) onLog(tokenMsg);

    try {
      const run = await startApifyRun(actorId, input, picked.tokenValue);
      return { run, tokenValue: picked.tokenValue, tokenDocId: picked.tokenDocId };
    } catch (err) {
      if (err instanceof ApifyLimitError) {
        const isAuthError = err.message.includes("Apify 401");
        const isPaymentError = err.message.includes("Apify 402");
        const reason = isAuthError ? "auth failed" : isPaymentError ? "hit monthly spending limit" : "hit limit";
        logger.info(`Token ${picked.tokenDocId || "legacy"} ${reason}: ${err.message}`);
        if (picked.tokenDocId) {
          await markTokenLimitReached(picked.tokenDocId, err.message);
          if (onLog) onLog(`Apify token "${picked.tokenDocId}" ${reason} — rotating to next token`, "warn");
          continue;
        }
        throw err;
      }
      throw err;
    }
  }
  throw new ApifyLimitError("All Apify tokens exhausted after rotation attempts");
}

async function pollApifyRun(runId, token) {
  const MAX_RETRIES = 4;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        return data.data;
      }
      if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
        logger.info(`Poll got ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`Apify poll failed (${res.status})`);
    } catch (err) {
      if (attempt < MAX_RETRIES && err.message && !err.message.startsWith("Apify poll failed")) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
        logger.info(`Poll network error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES}):`, err.message);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Wait for an Apify run to reach a terminal state.
 * @param {string} runId
 * @param {string} token
 * @param {Object} [cancelHandle] - optional { cancelled, paused } for early exit
 * @returns {Object|null} run data, or null if cancelled/paused
 */
async function waitForApifyRun(runId, token, cancelHandle) {
  while (true) {
    if (cancelHandle && (cancelHandle.cancelled || cancelHandle.paused)) return null;
    const run = await pollApifyRun(runId, token);
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
      return run;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function getDatasetItems(datasetId, token) {
  if (!datasetId) return [];
  const res = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?format=json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return res.json();
}

async function abortApifyRun(runId, token) {
  try {
    await fetch(`${APIFY_BASE}/actor-runs/${runId}/abort`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort
  }
}

module.exports = {
  // Actor IDs
  REEL_SCRAPER,
  POST_SCRAPER,
  COMMENT_SCRAPER,
  PROFILE_SCRAPER,
  LIKER_SCRAPER,
  FOLLOWERS_SCRAPER,
  // Constants
  APIFY_BASE,
  APIFY_MEMORY_MB,
  APIFY_MAX_CHARGE_USD,
  // Error class
  ApifyLimitError,
  // Functions
  startApifyRun,
  pickApifyToken,
  markTokenLimitReached,
  fetchApifyUsage,
  startApifyRunWithRotation,
  pollApifyRun,
  waitForApifyRun,
  getDatasetItems,
  abortApifyRun,
};

const logger = require("./logger").child({ module: "clickupErrorReporter" });

// Deduplicate: track recently reported errors to avoid flooding ClickUp
const recentErrors = new Map(); // key → timestamp
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

function errorKey(method, url, message) {
  return `${method}:${url}:${message}`;
}

function cleanStaleEntries() {
  const now = Date.now();
  for (const [key, ts] of recentErrors) {
    if (now - ts > DEDUP_WINDOW_MS) recentErrors.delete(key);
  }
}

/**
 * Report a 500-level error to ClickUp as a task.
 * Fire-and-forget — never throws.
 */
async function reportErrorToClickUp({ method, url, status, message, stack, reqId }) {
  const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN;
  const CLICKUP_ERROR_LIST_ID = process.env.CLICKUP_ERROR_LIST_ID;
  if (!CLICKUP_API_TOKEN || !CLICKUP_ERROR_LIST_ID) return;

  try {
    const key = errorKey(method, url, message);
    cleanStaleEntries();

    if (recentErrors.has(key)) return; // already reported recently
    recentErrors.set(key, Date.now());

    const name = `[${status}] ${method} ${url} — ${message}`.slice(0, 200);
    const description = [
      `**Status:** ${status}`,
      `**Method:** ${method}`,
      `**URL:** ${url}`,
      `**Request ID:** ${reqId || "N/A"}`,
      `**Error:** ${message}`,
      `**Time:** ${new Date().toISOString()}`,
      "",
      "**Stack Trace:**",
      "```",
      stack || "No stack trace",
      "```",
    ].join("\n");

    const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_ERROR_LIST_ID}/task`, {
      method: "POST",
      headers: {
        Authorization: CLICKUP_API_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        description,
        status: "to do",
        priority: 2, // high
        tags: ["bug", "auto-reported"],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, "Failed to create ClickUp error task");
    } else {
      logger.info({ method, url }, "Error reported to ClickUp");
    }
  } catch (err) {
    logger.warn({ err }, "ClickUp error reporter failed");
  }
}

module.exports = { reportErrorToClickUp };

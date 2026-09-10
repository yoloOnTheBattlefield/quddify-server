const logger = require("../utils/logger").child({ module: "commentAutomation" });

const Account = require("../models/Account");
const CommentRule = require("../models/CommentRule");
const CommentEvent = require("../models/CommentEvent");
const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const { findIgOwner } = require("../utils/igOwner");
const escapeRegex = require("../utils/escapeRegex");
const { notifyNewLead } = require("./telegramNotifier");

const GRAPH = "https://graph.facebook.com/v21.0";

// Meta's documented ceiling for private replies is 750/hour per IG account.
const HOURLY_SEND_LIMIT = 750;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 5 * 60 * 1000; // 5 min, doubled per attempt

// ─── Keyword matching ────────────────────────────────────────────────────────

/**
 * Returns the keyword that matched, or null.
 * "partial" matches anywhere in the text ("linkedin" matches rule "link").
 * "whole" requires a word boundary on both sides.
 */
function matchKeyword(text, keywords, matchMode = "partial") {
  if (!text || !Array.isArray(keywords) || keywords.length === 0) return null;
  const haystack = text.toLowerCase();

  for (const raw of keywords) {
    const keyword = String(raw || "").trim().toLowerCase();
    if (!keyword) continue;

    if (matchMode === "whole") {
      // \b is unreliable next to emoji and non-ASCII, so bound on
      // "not a letter/digit/underscore" instead.
      const re = new RegExp(
        `(^|[^\\p{L}\\p{N}_])${escapeRegex(keyword)}([^\\p{L}\\p{N}_]|$)`,
        "u",
      );
      if (re.test(haystack)) return keyword;
    } else if (haystack.includes(keyword)) {
      return keyword;
    }
  }

  return null;
}

/**
 * First active rule whose media scope and keywords both match.
 * An empty media_ids list means "every post on this account".
 */
function findMatchingRule(rules, { text, mediaId }) {
  for (const rule of rules || []) {
    if (rule.active === false) continue;

    const scoped = Array.isArray(rule.media_ids) && rule.media_ids.length > 0;
    if (scoped && !rule.media_ids.includes(mediaId)) continue;

    const keyword = matchKeyword(text, rule.keywords, rule.match_mode);
    if (keyword) return { rule, keyword };
  }

  return null;
}

function resolveTemplate(template, { username, fullName, link }) {
  const name = fullName || username || "";
  const firstName = name.split(/\s+/)[0] || "";
  return String(template || "")
    .replace(/\{\{username\}\}/g, username || "")
    .replace(/\{\{firstName\}\}/g, firstName)
    .replace(/\{\{name\}\}/g, name)
    .replace(/\{\{link\}\}/g, link || "");
}

/**
 * Append the lead id as utm_medium so the existing /t tracking script
 * attributes the click back to this lead (same contract as every other channel).
 */
function buildTrackedLink(linkUrl, leadId) {
  if (!linkUrl) return "";
  try {
    const url = new URL(linkUrl);
    if (leadId) {
      url.searchParams.set("utm_source", "comment_automation");
      url.searchParams.set("utm_medium", String(leadId));
    }
    return url.toString();
  } catch {
    // Not a parseable URL — hand it back untouched rather than dropping it
    return linkUrl;
  }
}

// ─── Webhook path: match a comment and queue the reply ──────────────────────

/**
 * Handles one `changes[]` entry with field "comments".
 * Writes a CommentEvent (queued or skipped) and returns it, or null when the
 * comment is not ours / not actionable.
 */
async function handleCommentChange(value, entryIgUserId) {
  const commentId = value?.id;
  const commentText = value?.text || "";
  const mediaId = value?.media?.id || null;
  const fromId = value?.from?.id || null;
  const fromUsername = value?.from?.username || null;
  const igUserId = entryIgUserId || value?.media?.ig_id || null;

  if (!commentId || !igUserId) return null;

  // Never reply to ourselves (our own replies fire the webhook too).
  if (fromId && String(fromId) === String(igUserId)) return null;

  const owner = await findIgOwner(igUserId);
  if (!owner) {
    logger.warn(`[comment-automation] No owner for IG account ${igUserId}`);
    return null;
  }

  const rules = await CommentRule.find({
    account_id: owner.account_id,
    ig_user_id: igUserId,
    active: true,
  }).lean();

  const match = findMatchingRule(rules, { text: commentText, mediaId });
  if (!match) return null;

  const { rule, keyword } = match;

  // Idempotent insert. IG allows exactly one private reply per comment and Meta
  // redelivers webhooks, so the unique index on comment_id is the real guard.
  try {
    const event = await CommentEvent.create({
      account_id: owner.account_id,
      rule_id: rule._id,
      ig_user_id: igUserId,
      comment_id: commentId,
      media_id: mediaId,
      comment_text: commentText,
      matched_keyword: keyword,
      commenter_ig_id: fromId,
      commenter_username: fromUsername,
      status: "queued",
      next_attempt_at: new Date(),
    });

    await CommentRule.updateOne({ _id: rule._id }, { $inc: { matched_count: 1 } });
    logger.info(
      `[comment-automation] Queued reply for comment ${commentId} (@${fromUsername || "?"}, keyword "${keyword}")`,
    );
    return event;
  } catch (err) {
    if (err.code === 11000) {
      logger.info(`[comment-automation] Duplicate comment ${commentId} ignored`);
      return null;
    }
    throw err;
  }
}

// ─── Graph API calls ─────────────────────────────────────────────────────────

async function sendPrivateReply(igUserId, commentId, text, pageAccessToken) {
  const res = await fetch(`${GRAPH}/${igUserId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: { text },
      access_token: pageAccessToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Private reply failed");
  return data;
}

async function sendPublicReply(commentId, text, pageAccessToken) {
  const res = await fetch(`${GRAPH}/${commentId}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text, access_token: pageAccessToken }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Public reply failed");
  return data;
}

async function fetchPermalink(mediaId, pageAccessToken) {
  try {
    const res = await fetch(
      `${GRAPH}/${mediaId}?fields=permalink&access_token=${pageAccessToken}`,
    );
    const data = await res.json();
    return data.permalink || null;
  } catch {
    return null;
  }
}

// ─── Lead upsert ─────────────────────────────────────────────────────────────

/**
 * Upsert the commenter as an inbound Lead and cross-link an existing
 * OutboundLead when we have already scraped or messaged them.
 *
 * account_id is Account._id.toString() — never a GHL location string.
 * See the 2026-04-02 data-integrity fix; every read path filters on the ObjectId.
 */
async function upsertLeadFromComment(event, rule, permalink) {
  const username = String(event.commenter_username || "").replace(/^@/, "").trim();
  if (!username) return null;

  const accountIdStr = event.account_id.toString();

  const lead = await Lead.findOneAndUpdate(
    { ig_username: username, account_id: accountIdStr },
    {
      $set: {
        source: `comment:${rule?.name || rule?._id || "rule"}`,
        platform: "instagram",
        ...(permalink ? { post_url: permalink } : {}),
      },
      $setOnInsert: { date_created: new Date().toISOString() },
    },
    { upsert: true, new: true },
  );

  if (!lead.outbound_lead_id) {
    const obLead = await OutboundLead.findOne({
      username: { $regex: new RegExp(`^${escapeRegex(username)}$`, "i") },
      account_id: event.account_id,
    }).lean();
    if (obLead) {
      await Lead.updateOne({ _id: lead._id }, { $set: { outbound_lead_id: obLead._id } });
      lead.outbound_lead_id = obLead._id;
    }
  }

  return lead;
}

// ─── Drain path: send the queued replies ────────────────────────────────────

async function sentInLastHour(igUserId) {
  return CommentEvent.countDocuments({
    ig_user_id: igUserId,
    status: "sent",
    sent_at: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  });
}

async function processEvent(event) {
  const owner = await findIgOwner(event.ig_user_id);
  if (!owner || !owner.pageAccessToken) {
    await CommentEvent.updateOne(
      { _id: event._id },
      { $set: { status: "skipped", skip_reason: "no_access_token" } },
    );
    return;
  }

  const rule = event.rule_id ? await CommentRule.findById(event.rule_id).lean() : null;
  if (!rule || rule.active === false) {
    await CommentEvent.updateOne(
      { _id: event._id },
      { $set: { status: "skipped", skip_reason: "rule_inactive" } },
    );
    return;
  }

  const permalink = event.media_id
    ? await fetchPermalink(event.media_id, owner.pageAccessToken)
    : null;

  const lead = await upsertLeadFromComment(event, rule, permalink);

  const link = buildTrackedLink(rule.link_url, lead?._id);
  const dmText = resolveTemplate(rule.dm_text, {
    username: event.commenter_username,
    fullName: null,
    link,
  });

  try {
    await sendPrivateReply(event.ig_user_id, event.comment_id, dmText, owner.pageAccessToken);
  } catch (err) {
    const attempts = event.attempts + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    await CommentEvent.updateOne(
      { _id: event._id },
      {
        $set: {
          status: exhausted ? "failed" : "queued",
          attempts,
          error: err.message,
          next_attempt_at: new Date(Date.now() + BASE_BACKOFF_MS * 2 ** attempts),
          ...(lead ? { lead_id: lead._id } : {}),
        },
      },
    );
    logger.error(
      `[comment-automation] Private reply failed for ${event.comment_id} (attempt ${attempts}): ${err.message}`,
    );
    return;
  }

  // Public reply is best-effort — a failure here must not re-send the DM.
  let publicReplied = false;
  if (rule.reply_publicly && rule.public_replies?.length > 0) {
    const pick = rule.public_replies[Math.floor(Math.random() * rule.public_replies.length)];
    try {
      await sendPublicReply(
        event.comment_id,
        resolveTemplate(pick, { username: event.commenter_username, link }),
        owner.pageAccessToken,
      );
      publicReplied = true;
    } catch (err) {
      logger.warn(`[comment-automation] Public reply failed for ${event.comment_id}: ${err.message}`);
    }
  }

  await CommentEvent.updateOne(
    { _id: event._id },
    {
      $set: {
        status: "sent",
        sent_at: new Date(),
        attempts: event.attempts + 1,
        error: null,
        public_replied: publicReplied,
        ...(lead ? { lead_id: lead._id } : {}),
      },
    },
  );
  await CommentRule.updateOne({ _id: rule._id }, { $inc: { sent_count: 1 } });

  logger.info(`[comment-automation] Sent DM for comment ${event.comment_id} to @${event.commenter_username}`);

  if (lead) {
    const account = await Account.findById(event.account_id).lean();
    const obLead = lead.outbound_lead_id
      ? await OutboundLead.findById(lead.outbound_lead_id).lean()
      : null;
    notifyNewLead(account, lead, obLead).catch((err) =>
      logger.error({ err }, "[comment-automation] Telegram notify error"),
    );
  }
}

/**
 * Drains due events, oldest first, respecting the per-account hourly cap.
 * Returns the number of events processed.
 */
async function processDueEvents(limit = 50) {
  const due = await CommentEvent.find({
    status: "queued",
    next_attempt_at: { $lte: new Date() },
  })
    .sort({ createdAt: 1 })
    .limit(limit);

  if (due.length === 0) return 0;

  // Cache the trailing-hour count per IG account so one slow account
  // doesn't force a countDocuments per event.
  const budget = new Map();
  let processed = 0;

  for (const event of due) {
    if (!budget.has(event.ig_user_id)) {
      budget.set(event.ig_user_id, HOURLY_SEND_LIMIT - (await sentInLastHour(event.ig_user_id)));
    }

    if (budget.get(event.ig_user_id) <= 0) {
      logger.warn(`[comment-automation] Hourly limit reached for IG ${event.ig_user_id} — deferring`);
      continue;
    }

    try {
      await processEvent(event);
      budget.set(event.ig_user_id, budget.get(event.ig_user_id) - 1);
      processed += 1;
    } catch (err) {
      logger.error(`[comment-automation] processEvent threw for ${event.comment_id}:`, err);
    }
  }

  return processed;
}

module.exports = {
  matchKeyword,
  findMatchingRule,
  resolveTemplate,
  buildTrackedLink,
  handleCommentChange,
  upsertLeadFromComment,
  processEvent,
  processDueEvents,
  HOURLY_SEND_LIMIT,
  MAX_ATTEMPTS,
};

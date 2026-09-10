const logger = require("../utils/logger").child({ module: "instagramInsights" });
const Account = require("../models/Account");
const MediaInsight = require("../models/MediaInsight");
const { decrypt } = require("../utils/crypto");

const GRAPH = "https://graph.facebook.com/v21.0";

const MEDIA_FIELDS = [
  "id",
  "media_type",
  "media_product_type",
  "timestamp",
  "permalink",
  "caption",
  "thumbnail_url",
  "like_count",
  "comments_count",
].join(",");

// Metric names differ by media type and Meta rejects the whole request if one
// is invalid for the media, so each type gets its own list.
const METRICS_BY_TYPE = {
  REELS: ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"],
  FEED: ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"],
  STORY: ["views", "reach"],
};

function metricsFor(mediaProductType) {
  return METRICS_BY_TYPE[mediaProductType] || METRICS_BY_TYPE.FEED;
}

/**
 * Every post on the account since `days` ago, following pagination.
 * Stories are excluded — they expire, so caching their numbers is meaningless.
 */
async function fetchAccountMedia({ igUserId, token, days = 90 }) {
  const sinceUnix = Math.floor((Date.now() - days * 86400000) / 1000);
  let url = `${GRAPH}/${igUserId}/media?fields=${MEDIA_FIELDS}&since=${sinceUnix}&limit=100&access_token=${token}`;

  const media = [];
  while (url) {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "Instagram API error");

    for (const item of data.data || []) {
      if (item.media_product_type === "STORY") continue;
      media.push(item);
    }
    url = data.paging?.next || null;
  }

  return media;
}

/**
 * Insights for one media. Returns { metrics, error }: a failure here is
 * reported per-post rather than thrown, so one unsupported post can't abort a
 * whole sync.
 */
async function fetchMediaInsights({ mediaId, mediaProductType, token }) {
  const metric = metricsFor(mediaProductType).join(",");

  try {
    const res = await fetch(
      `${GRAPH}/${mediaId}/insights?metric=${metric}&access_token=${token}`,
    );
    const data = await res.json();

    if (data.error) return { metrics: {}, error: data.error.message || "insights unavailable" };

    const metrics = {};
    for (const row of data.data || []) {
      const value = row.values?.[0]?.value;
      if (typeof value === "number") metrics[row.name] = value;
    }
    return { metrics, error: null };
  } catch (err) {
    return { metrics: {}, error: err.message };
  }
}

/**
 * Refreshes the cached metrics for an account's recent posts.
 * Requires a Meta page token — a Zernio-only account has none, and there is no
 * Zernio equivalent, so this reports that plainly instead of failing obscurely.
 */
async function syncAccountInsights(accountId, { days = 90 } = {}) {
  const account = await Account.findById(accountId).select("ig_oauth").lean();
  if (!account) throw new Error("Account not found");

  const token = decrypt(account.ig_oauth?.page_access_token);
  const igUserId = account.ig_oauth?.ig_user_id;

  if (!token || !igUserId) {
    const err = new Error(
      "Instagram content analytics need a Meta connection. Connect Instagram under Integrations — Zernio does not expose post metrics.",
    );
    err.code = "NO_META_CONNECTION";
    throw err;
  }

  const media = await fetchAccountMedia({ igUserId, token, days });
  let withInsights = 0;

  for (const item of media) {
    const { metrics, error } = await fetchMediaInsights({
      mediaId: item.id,
      mediaProductType: item.media_product_type,
      token,
    });
    if (!error) withInsights += 1;

    await MediaInsight.findOneAndUpdate(
      { account_id: accountId, media_id: item.id },
      {
        $set: {
          ig_user_id: igUserId,
          permalink: item.permalink || null,
          caption: item.caption || null,
          media_type: item.media_type || null,
          media_product_type: item.media_product_type || null,
          thumbnail_url: item.thumbnail_url || null,
          posted_at: item.timestamp ? new Date(item.timestamp) : null,
          like_count: item.like_count ?? 0,
          comments_count: item.comments_count ?? 0,
          views: metrics.views ?? null,
          reach: metrics.reach ?? null,
          shares: metrics.shares ?? null,
          saved: metrics.saved ?? null,
          total_interactions: metrics.total_interactions ?? null,
          insights_error: error,
          fetched_at: new Date(),
        },
      },
      { upsert: true },
    );
  }

  logger.info(
    `[insights] Synced ${media.length} post(s) for account ${accountId} (${withInsights} with insights)`,
  );

  return { synced: media.length, with_insights: withInsights };
}

module.exports = {
  GRAPH,
  metricsFor,
  fetchAccountMedia,
  fetchMediaInsights,
  syncAccountInsights,
};

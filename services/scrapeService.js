const logger = require("../utils/logger").child({ module: "youtube-scrapeService" });
const { ApifyClient } = require("apify-client");
const Channel = require("../models/Channel");
const Video = require("../models/Video");
const TrendAlert = require("../models/TrendAlert");
const TrendingVideo = require("../models/TrendingVideo");
const ApifyToken = require("../models/ApifyToken");
const Account = require("../models/Account");

const VELOCITY_THRESHOLD = Number(process.env.VELOCITY_THRESHOLD) || 500;
const TRENDING_CATEGORIES = (process.env.TRENDING_CATEGORIES || "1,10,20,24,25")
  .split(",")
  .map((c) => c.trim());
const TRENDING_COUNTRIES = (process.env.TRENDING_COUNTRIES || "US,GB,CA")
  .split(",")
  .map((c) => c.trim());

// ─── Token rotation ─────────────────────────────────────────────────────
//
// Picks the first active ApifyToken for an account (least recently used).
// Falls back to account.apify_token for backward compatibility.

async function pickApifyToken(accountId) {
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

  // Fallback to legacy account-level token
  const account = await Account.findById(accountId).lean();
  const legacy = account?.apify_token;
  if (legacy) {
    const decrypted = Account.decryptField ? Account.decryptField(legacy) : legacy;
    if (decrypted) return { tokenValue: decrypted, tokenDocId: null };
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

function getClient(tokenValue) {
  return new ApifyClient({ token: tokenValue });
}

/**
 * Scrape latest videos from all active monitored channels for a given account.
 */
async function scrapeChannels(accountId) {
  const channels = await Channel.find({ account_id: accountId, active: true }).lean();
  if (channels.length === 0) {
    logger.info("No active channels to scrape for account:", accountId.toString());
    return { scraped: 0, videos: 0 };
  }

  const picked = await pickApifyToken(accountId);
  if (!picked) {
    throw new Error("No active Apify tokens available");
  }

  const client = getClient(picked.tokenValue);
  const channelUrls = channels.map((ch) => ({
    url: ch.channel_url || `https://www.youtube.com/channel/${ch.channel_id}`,
  }));

  logger.info(`Scraping ${channels.length} channel(s) via Apify for account ${accountId}`);

  let run;
  try {
    run = await client.actor("streamers/youtube-scraper").call({
      startUrls: channelUrls,
      maxResults: 50,
      maxResultsShorts: 0,
      maxResultStreams: 0,
    });
  } catch (err) {
    if (err.statusCode === 402 || err.statusCode === 403) {
      await markTokenLimitReached(picked.tokenDocId, err.message);
      throw new Error("Apify token limit reached — rotate or add a new token");
    }
    throw err;
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  logger.info(`Apify returned ${items.length} video(s)`);

  let videoCount = 0;
  for (const item of items) {
    const videoId = item.id || item.videoId;
    if (!videoId) continue;

    const channelId = item.channelId || item.channelName || null;
    const now = new Date();

    const update = {
      title: item.title || null,
      url: item.url || `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail_url: item.thumbnailUrl || null,
      published_at: item.date ? new Date(item.date) : null,
      duration: item.duration || null,
      views: item.viewCount || item.views || 0,
      likes: item.likes || 0,
      comments: item.commentsCount || item.comments || 0,
      last_scraped_at: now,
    };

    if (channelId) update.channel_id = channelId;

    const video = await Video.findOneAndUpdate(
      { video_id: videoId },
      {
        $set: update,
        $push: {
          snapshots: {
            views: update.views,
            likes: update.likes,
            comments: update.comments,
            scraped_at: now,
          },
        },
      },
      { upsert: true, new: true },
    );

    videoCount++;
  }

  // Map Apify's UC-style channel IDs back to our channel docs and update metadata
  const videoChannelIds = [...new Set(items.map((i) => i.channelId || i.channelName).filter(Boolean))];
  const now2 = new Date();
  for (const ch of channels) {
    // Find videos whose channelUrl contains the channel handle
    const handle = ch.channel_url?.split("/").pop(); // e.g. "@gradyssells"
    const matchedVideo = items.find((i) => {
      const vChannelUrl = i.channelUrl || "";
      return vChannelUrl.includes(handle) || vChannelUrl.includes(ch.channel_id);
    });
    if (matchedVideo) {
      const ytChannelId = matchedVideo.channelId || matchedVideo.channelName;
      const updateFields = { last_scraped_at: now2 };
      if (ytChannelId) updateFields.yt_channel_id = ytChannelId;
      if (matchedVideo.channelName && !ch.channel_name) {
        updateFields.channel_name = matchedVideo.channelName;
      }
      await Channel.updateOne({ _id: ch._id }, { $set: updateFields });
    }
  }

  logger.info(`Stored/updated ${videoCount} video(s)`);
  return { scraped: channels.length, videos: videoCount };
}

/**
 * Calculate views-per-hour for recent videos and flag breakouts.
 */
async function detectBreakouts() {
  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);

  const recentVideos = await Video.find({
    published_at: { $gte: cutoff },
    snapshots: { $exists: true, $not: { $size: 0 } },
  }).lean();

  logger.info(`Evaluating ${recentVideos.length} recent video(s) for breakout`);

  let alertCount = 0;
  for (const video of recentVideos) {
    const hoursAge = Math.max(
      (Date.now() - new Date(video.published_at).getTime()) / (1000 * 60 * 60),
      0.1,
    );
    const vph = Math.round(video.views / hoursAge);

    await Video.updateOne({ _id: video._id }, { $set: { views_per_hour: vph } });

    if (vph >= VELOCITY_THRESHOLD) {
      await TrendAlert.findOneAndUpdate(
        { video_id: video.video_id },
        {
          $set: {
            channel_id: video.channel_id,
            title: video.title,
            url: video.url,
            views: video.views,
            views_per_hour: vph,
            published_at: video.published_at,
            detected_at: new Date(),
            threshold_used: VELOCITY_THRESHOLD,
            active: true,
          },
        },
        { upsert: true },
      );
      alertCount++;
    }
  }

  await TrendAlert.updateMany(
    {
      active: true,
      $or: [
        { published_at: { $lt: cutoff } },
        { views_per_hour: { $lt: VELOCITY_THRESHOLD } },
      ],
    },
    { $set: { active: false } },
  );

  logger.info(`Detected ${alertCount} breakout alert(s)`);
  return { evaluated: recentVideos.length, alerts: alertCount };
}

/**
 * Scrape YouTube trending videos by category and country.
 */
async function scrapeTrending(accountId) {
  const picked = await pickApifyToken(accountId);
  if (!picked) {
    throw new Error("No active Apify tokens available");
  }

  const client = getClient(picked.tokenValue);
  const batchId = new Date().toISOString();

  logger.info(
    `Scraping trending for categories=[${TRENDING_CATEGORIES}] countries=[${TRENDING_COUNTRIES}]`,
  );

  let run;
  try {
    run = await client
      .actor("eunit/youtube-trending-videos-by-categories")
      .call({
        categories: TRENDING_CATEGORIES,
        countries: TRENDING_COUNTRIES,
      });
  } catch (err) {
    if (err.statusCode === 402 || err.statusCode === 403) {
      await markTokenLimitReached(picked.tokenDocId, err.message);
      throw new Error("Apify token limit reached — rotate or add a new token");
    }
    throw err;
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  logger.info(`Trending scrape returned ${items.length} video(s)`);

  let stored = 0;
  for (const item of items) {
    const videoId = item.videoId || item.id;
    if (!videoId) continue;

    await TrendingVideo.create({
      video_id: videoId,
      title: item.title || null,
      channel_name: item.channelName || item.channelTitle || null,
      channel_id: item.channelId || null,
      url: item.url || item.videoUrl || `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail_url: item.thumbnailUrl || item.thumbnail || null,
      views: item.viewCount || item.views || 0,
      likes: item.likes || 0,
      comments: item.commentsCount || item.comments || 0,
      category: item.category || null,
      country: item.country || null,
      published_at: item.publishedAt || item.date ? new Date(item.publishedAt || item.date) : null,
      scraped_at: new Date(),
      batch_id: batchId,
    });
    stored++;
  }

  logger.info(`Stored ${stored} trending video(s) in batch ${batchId}`);
  return { batch_id: batchId, videos: stored };
}

/**
 * Run the full scrape pipeline for a specific account.
 */
async function runFullPipeline(accountId) {
  logger.info("Starting full scrape pipeline for account:", accountId.toString());
  const channelResult = await scrapeChannels(accountId);
  const breakoutResult = await detectBreakouts();
  const trendingResult = await scrapeTrending(accountId);

  logger.info("Full pipeline complete");
  return {
    channels: channelResult,
    breakouts: breakoutResult,
    trending: trendingResult,
  };
}

/**
 * Run the pipeline for ALL accounts that have active Apify tokens.
 * Used by the scheduler.
 */
async function runForAllAccounts() {
  const accountIds = await ApifyToken.distinct("account_id", { status: "active" });
  logger.info(`Scheduler running pipeline for ${accountIds.length} account(s)`);

  const results = [];
  for (const accountId of accountIds) {
    try {
      const result = await runFullPipeline(accountId);
      results.push({ account_id: accountId, ...result });
    } catch (err) {
      logger.error(`Pipeline failed for account ${accountId}:`, err);
      results.push({ account_id: accountId, error: err.message });
    }
  }
  return results;
}

module.exports = {
  scrapeChannels,
  detectBreakouts,
  scrapeTrending,
  runFullPipeline,
  runForAllAccounts,
};

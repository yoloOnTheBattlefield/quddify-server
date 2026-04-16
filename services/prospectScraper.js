const logger = require("../utils/logger").child({ module: "prospectScraper" });
const ProspectProfile = require("../models/ProspectProfile");
const ClientImage = require("../models/ClientImage");
const Account = require("../models/Account");
const { upload: storageUpload } = require("./storageService");
const { tagImageBatch } = require("./carousel/imageTagging");
const { transcribeAudio } = require("./transcriptionService");
const { emitToAccount } = require("./socketManager");
const {
  POST_SCRAPER,
  REEL_SCRAPER,
  PROFILE_SCRAPER,
  startApifyRunWithRotation,
  waitForApifyRun,
  getDatasetItems,
} = require("./apifyHelpers");

const sharp = require("sharp");

// ─── Cancellation ───────────────────────────────────────────────────────

const activeJobs = new Map(); // profileId -> { cancelled: boolean }

function cancelScrapeJob(profileId) {
  const handle = activeJobs.get(profileId);
  if (handle) {
    handle.cancelled = true;
    return true;
  }
  return false;
}

// ─── Progress helpers ───────────────────────────────────────────────────

async function emitProgress(accountId, profileId, step, progress, message) {
  // Persist step to DB so polling clients can track progress
  await ProspectProfile.findByIdAndUpdate(profileId, { current_step: step, progress });
  emitToAccount(accountId, "outreach:scrape:progress", {
    profileId,
    step,
    progress,
    message,
  });
}

// ─── Image download ─────────────────────────────────────────────────────

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function downloadAndStoreImage(url, accountId, profileId, index) {
  try {
    const buffer = await downloadImage(url);
    if (!buffer || buffer.length < 1024) return null; // skip tiny/broken images

    // Get image metadata
    const metadata = await sharp(buffer).metadata();
    const key = `prospect/${profileId}/image-${index}.jpg`;

    // Convert to JPEG for consistency
    const jpegBuffer = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
    await storageUpload(key, jpegBuffer, "image/jpeg");

    return {
      storage_key: key,
      width: metadata.width || 0,
      height: metadata.height || 0,
      file_size: jpegBuffer.length,
      aspect_ratio: metadata.width && metadata.height ? metadata.width / metadata.height : 1,
      is_portrait: metadata.height > metadata.width,
    };
  } catch (err) {
    logger.warn(`Failed to download image ${index} from ${url}: ${err.message}`);
    return null;
  }
}

// ─── Video/audio download for reel transcription ────────────────────────

async function downloadVideo(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn(`Failed to download video: ${err.message}`);
    return null;
  }
}

// ─── Main scraper ───────────────────────────────────────────────────────

/**
 * Scrape a prospect's Instagram content.
 * @param {string} profileId - ProspectProfile document ID
 * @param {string} accountId - Account ID (for Apify tokens, storage)
 */
async function scrapeProspectContent(profileId, accountId, directUrls) {
  const profile = await ProspectProfile.findById(profileId);
  if (!profile) throw new Error(`ProspectProfile ${profileId} not found`);

  const account = await Account.findById(accountId).lean();
  const legacyToken = account?.apify_token;
  const handle = profile.ig_handle.replace(/^@/, "");

  const onLog = (msg) => logger.info(`[prospect-scraper] ${msg}`);
  let apifyCostUsd = 0;
  const jobHandle = { cancelled: false };
  activeJobs.set(profileId, jobHandle);

  function checkCancelled() {
    if (jobHandle.cancelled) {
      throw new Error("Job cancelled by user");
    }
  }

  try {
    await ProspectProfile.findByIdAndUpdate(profileId, {
      status: "scraping",
      scrape_started_at: new Date(),
    });

    // ── Step 1: Fetch profile info ──────────────────────────────────────
    emitProgress(accountId, profileId, "profile", 5, "Fetching profile info...");

    const { run: profileRun, tokenValue: profileToken } = await startApifyRunWithRotation(
      PROFILE_SCRAPER,
      { usernames: [handle] },
      accountId,
      legacyToken,
      onLog,
    );

    const profileResult = await waitForApifyRun(profileRun.id, profileToken);
    if (profileResult?.usageTotalUsd) apifyCostUsd += profileResult.usageTotalUsd;
    if (profileResult && profileResult.status === "SUCCEEDED") {
      const items = await getDatasetItems(profileRun.defaultDatasetId, profileToken);
      if (items.length > 0) {
        const p = items[0];
        await ProspectProfile.findByIdAndUpdate(profileId, {
          ig_bio: p.biography || p.bio || "",
          ig_profile_picture_url: p.profilePicUrl || p.profilePicUrlHD || "",
          ig_followers_count: p.followersCount || p.followerCount || 0,
          "profile.name": p.fullName || handle,
        });
      }
    }

    const isDirectMode = Array.isArray(directUrls) && directUrls.length > 0;

    checkCancelled();
    // ── Step 2: Scrape posts ────────────────────────────────────────────
    const posts = [];
    const imageUrls = [];
    const reels = [];

    if (isDirectMode) {
      // Direct URL mode — scrape specific URLs provided by the user
      emitProgress(accountId, profileId, "posts", 15, `Scraping ${directUrls.length} provided URLs...`);

      const { run: directRun, tokenValue: directToken } = await startApifyRunWithRotation(
        POST_SCRAPER,
        { directUrls },
        accountId,
        legacyToken,
        onLog,
      );

      const directResult = await waitForApifyRun(directRun.id, directToken);
      if (directResult?.usageTotalUsd) apifyCostUsd += directResult.usageTotalUsd;

      if (directResult && directResult.status === "SUCCEEDED") {
        const items = await getDatasetItems(directRun.defaultDatasetId, directToken);
        for (const item of items) {
          const isReel = item.type === "Video" || item.videoUrl;
          if (isReel) {
            reels.push({
              url: item.url || (item.shortCode ? `https://www.instagram.com/reel/${item.shortCode}/` : ""),
              video_url: item.videoUrl || "",
              thumbnail_url: item.displayUrl || item.thumbnailUrl || "",
              caption: item.caption || "",
              likes: item.likesCount || item.likes || 0,
              comments: item.commentsCount || item.comments || 0,
              views: item.videoViewCount || item.videoPlayCount || item.views || 0,
              timestamp: item.timestamp ? new Date(item.timestamp) : null,
              transcript: "",
            });
          } else {
            const post = {
              url: item.url || (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : ""),
              image_urls: [],
              caption: item.caption || "",
              likes: item.likesCount || item.likes || 0,
              comments: item.commentsCount || item.comments || 0,
              timestamp: item.timestamp ? new Date(item.timestamp) : null,
              type: item.childPosts?.length > 0 ? "carousel" : "image",
            };
            if (item.displayUrl) { post.image_urls.push(item.displayUrl); imageUrls.push(item.displayUrl); }
            if (item.childPosts) {
              for (const child of item.childPosts) {
                if (child.displayUrl) { post.image_urls.push(child.displayUrl); imageUrls.push(child.displayUrl); }
              }
            }
            posts.push(post);
          }
        }
        logger.info(`Direct mode: scraped ${posts.length} posts + ${reels.length} reels from ${directUrls.length} URLs`);
      }
    } else {
      // Auto mode — scrape recent posts by handle
      emitProgress(accountId, profileId, "posts", 15, "Scraping recent posts...");

      const { run: postsRun, tokenValue: postsToken } = await startApifyRunWithRotation(
        POST_SCRAPER,
        { username: [handle], resultsLimit: 30 },
        accountId,
        legacyToken,
        onLog,
      );

      const postsResult = await waitForApifyRun(postsRun.id, postsToken);
      if (postsResult?.usageTotalUsd) apifyCostUsd += postsResult.usageTotalUsd;

      if (postsResult && postsResult.status === "SUCCEEDED") {
        const items = await getDatasetItems(postsRun.defaultDatasetId, postsToken);
        for (const item of items) {
          const post = {
            url: item.url || (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : ""),
            image_urls: [],
            caption: item.caption || "",
            likes: item.likesCount || item.likes || 0,
            comments: item.commentsCount || item.comments || 0,
            timestamp: item.timestamp ? new Date(item.timestamp) : null,
            type: item.type === "Video" ? "reel" : item.childPosts?.length > 0 ? "carousel" : "image",
          };
          if (item.displayUrl) { post.image_urls.push(item.displayUrl); imageUrls.push(item.displayUrl); }
          if (item.images && Array.isArray(item.images)) {
            for (const img of item.images) { if (img) { post.image_urls.push(img); imageUrls.push(img); } }
          }
          if (item.childPosts && Array.isArray(item.childPosts)) {
            for (const child of item.childPosts) { if (child.displayUrl) { post.image_urls.push(child.displayUrl); imageUrls.push(child.displayUrl); } }
          }
          posts.push(post);
        }
        logger.info(`Scraped ${posts.length} posts with ${imageUrls.length} images for @${handle}`);
      }
    }

    await ProspectProfile.findByIdAndUpdate(profileId, { scraped_posts: posts });

    checkCancelled();
    // ── Step 3: Download and store images ───────────────────────────────
    emitProgress(accountId, profileId, "images", 30, `Downloading ${imageUrls.length} images...`);

    const imagesToDownload = imageUrls.slice(0, 30);
    const imageIds = [];

    for (let i = 0; i < imagesToDownload.length; i += 5) {
      const batch = imagesToDownload.slice(i, i + 5);
      const results = await Promise.all(
        batch.map((url, idx) => downloadAndStoreImage(url, accountId, profileId, i + idx)),
      );

      for (const result of results) {
        if (!result) continue;
        const clientImage = await ClientImage.create({
          client_id: profile.client_id,
          account_id: accountId,
          storage_key: result.storage_key,
          mime_type: "image/jpeg",
          width: result.width,
          height: result.height,
          file_size: result.file_size,
          aspect_ratio: result.aspect_ratio,
          is_portrait: result.is_portrait,
          status: "ready",
          source: "prospect_scrape",
          prospect_profile_id: profileId,
        });
        imageIds.push(clientImage._id);
      }

      const progress = 30 + Math.round(((i + batch.length) / imagesToDownload.length) * 20);
      emitProgress(accountId, profileId, "images", progress, `Downloaded ${i + batch.length}/${imagesToDownload.length} images`);
    }

    await ProspectProfile.findByIdAndUpdate(profileId, { image_ids: imageIds });
    logger.info(`Stored ${imageIds.length} images for @${handle}`);

    checkCancelled();
    // ── Step 4: Scrape reels (skip if direct mode already got them) ─────
    if (!isDirectMode) {
      emitProgress(accountId, profileId, "reels", 55, "Scraping recent reels...");

      const { run: reelsRun, tokenValue: reelsToken } = await startApifyRunWithRotation(
        REEL_SCRAPER,
        { username: [handle], resultsLimit: 10 },
        accountId,
        legacyToken,
        onLog,
      );

      const reelsResult = await waitForApifyRun(reelsRun.id, reelsToken);
      if (reelsResult?.usageTotalUsd) apifyCostUsd += reelsResult.usageTotalUsd;

      if (reelsResult && reelsResult.status === "SUCCEEDED") {
        const items = await getDatasetItems(reelsRun.defaultDatasetId, reelsToken);
        for (const item of items) {
          reels.push({
            url: item.url || (item.shortCode ? `https://www.instagram.com/reel/${item.shortCode}/` : ""),
            video_url: item.videoUrl || "",
            thumbnail_url: item.displayUrl || item.thumbnailUrl || "",
            caption: item.caption || "",
            likes: item.likesCount || item.likes || 0,
            comments: item.commentsCount || item.comments || 0,
            views: item.videoViewCount || item.videoPlayCount || item.views || 0,
            timestamp: item.timestamp ? new Date(item.timestamp) : null,
            transcript: "",
          });
        }
        logger.info(`Scraped ${reels.length} reels for @${handle}`);
      }
    }

    checkCancelled();
    // ── Step 5: Transcribe top 5 reels by engagement ────────────────────
    // Sort by likes + views, only transcribe the top performers
    const reelsByEngagement = [...reels].sort((a, b) => (b.likes + b.views) - (a.likes + a.views));
    const reelsToTranscribe = reelsByEngagement.slice(0, 5).filter((r) => r.video_url);

    emitProgress(accountId, profileId, "transcribing", 70, `Transcribing top ${reelsToTranscribe.length} reels...`);

    for (let i = 0; i < reelsToTranscribe.length; i += 3) {
      const batch = reelsToTranscribe.slice(i, i + 3);
      const transcriptions = await Promise.all(
        batch.map(async (reel) => {
          try {
            const videoBuffer = await downloadVideo(reel.video_url);
            if (!videoBuffer) return "";
            return await transcribeAudio(videoBuffer, "audio/mp4", accountId, `reel-${i}.mp4`);
          } catch (err) {
            logger.warn(`Failed to transcribe reel: ${err.message}`);
            return "";
          }
        }),
      );
      for (let j = 0; j < batch.length; j++) {
        // Write transcript back to the original reel object
        const original = reels.find((r) => r.url === batch[j].url);
        if (original) original.transcript = transcriptions[j] || "";
      }
      const progress = 70 + Math.round(((i + batch.length) / reelsToTranscribe.length) * 18);
      emitProgress(accountId, profileId, "transcribing", progress, `Transcribed ${i + batch.length}/${reelsToTranscribe.length} reels`);
    }

    await ProspectProfile.findByIdAndUpdate(profileId, { scraped_reels: reels });

    const transcribedCount = reels.filter((r) => r.transcript).length;
    logger.info(`Transcribed ${transcribedCount}/${reels.length} reels for @${handle}`);

    checkCancelled();
    // ── Step 6: Hand off to profiling ───────────────────────────────────
    emitProgress(accountId, profileId, "profiling", 92, "Generating prospect profile...");

    // Whisper: $0.006/minute, avg reel ~60s = ~$0.006/reel
    const openaiWhisperCost = transcribedCount * 0.006;
    const openaiCostUsd = openaiWhisperCost;

    await ProspectProfile.findByIdAndUpdate(profileId, {
      status: "profiling",
      "cost.apify_usd": Math.round(apifyCostUsd * 10000) / 10000,
      "cost.openai_usd": Math.round(openaiCostUsd * 10000) / 10000,
    });

    logger.info(`Scrape costs for @${handle}: Apify $${apifyCostUsd.toFixed(4)}, OpenAI ~$${openaiCostUsd.toFixed(4)}`);

    // Profile generation is called by the route handler after scraping completes
    return { profileId, imageCount: imageIds.length, postCount: posts.length, reelCount: reels.length, transcribedCount };
  } catch (err) {
    const isCancelled = jobHandle.cancelled || err.message === "Job cancelled by user";

    if (isCancelled) {
      logger.info(`Prospect scraping cancelled for @${handle}`);
      await ProspectProfile.findByIdAndUpdate(profileId, {
        status: "failed",
        error: "Cancelled",
        current_step: "cancelled",
      });
      emitProgress(accountId, profileId, "cancelled", 0, "Cancelled");
    } else {
      logger.error(`Prospect scraping failed for @${handle}:`, err);
      await ProspectProfile.findByIdAndUpdate(profileId, {
        status: "failed",
        error: err.message,
      });
      emitProgress(accountId, profileId, "failed", 0, err.message);
    }

    throw err;
  } finally {
    activeJobs.delete(profileId);
  }
}

module.exports = { scrapeProspectContent, cancelScrapeJob };

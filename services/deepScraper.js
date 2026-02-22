const OpenAI = require("openai");
const DeepScrapeJob = require("../models/DeepScrapeJob");
const ApifyToken = require("../models/ApifyToken");
const ResearchPost = require("../models/ResearchPost");
const ResearchComment = require("../models/ResearchComment");
const OutboundLead = require("../models/OutboundLead");
const Account = require("../models/Account");
const Prompt = require("../models/Prompt");
const { qualifyBio, DEFAULT_QUALIFICATION_PROMPT } = require("./uploadService");
const { emitToAccount } = require("./socketManager");

// Apify actor IDs
const REEL_SCRAPER = "apify~instagram-reel-scraper";
const COMMENT_SCRAPER = "SbK00X0JYCPblD2wp";
const PROFILE_SCRAPER = "dSCLg0C3YEZ83HzYX";

const APIFY_BASE = "https://api.apify.com/v2";

const activeJobs = new Map(); // jobId -> { cancelled, paused, skipComments }

// ─── Apify helpers ───────────────────────────────────────────────────────

const APIFY_MEMORY_MB = 4096; // 4GB — uses more of the available compute for faster runs

// Custom error for 403 hard limit so callers can detect and rotate tokens
class ApifyLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApifyLimitError";
  }
}

async function startApifyRun(actorId, input, token) {
  const res = await fetch(`${APIFY_BASE}/acts/${actorId}/runs?memory=${APIFY_MEMORY_MB}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    // Detect 403 hard limit / actor-disabled errors
    if (res.status === 403) {
      throw new ApifyLimitError(`Apify 403: ${text}`);
    }
    throw new Error(`Apify start failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.data; // { id, defaultDatasetId, status, ... }
}

// ─── Token rotation ─────────────────────────────────────────────────────
//
// Picks the first active ApifyToken for an account. Falls back to account.apify_token
// for backward compatibility. Returns { tokenValue, tokenDocId } or null.

async function pickApifyToken(accountId, legacyToken) {
  // Try multi-token system first
  const tokens = await ApifyToken.find({
    account_id: accountId,
    status: "active",
  })
    .sort({ last_used_at: 1 }) // least recently used first
    .lean();

  if (tokens.length > 0) {
    const picked = tokens[0];
    await ApifyToken.updateOne(
      { _id: picked._id },
      { $set: { last_used_at: new Date() }, $inc: { usage_count: 1 } },
    );
    return { tokenValue: picked.token, tokenDocId: picked._id.toString() };
  }

  // Fallback to legacy single token on Account
  if (legacyToken) {
    return { tokenValue: legacyToken, tokenDocId: null };
  }

  return null;
}

async function markTokenLimitReached(tokenDocId, errorMsg) {
  if (!tokenDocId) return; // legacy token — nothing to mark
  await ApifyToken.updateOne(
    { _id: tokenDocId },
    { $set: { status: "limit_reached", last_error: errorMsg } },
  );
}

// Try to start an Apify run with token rotation. If 403, mark token and try next.
// Returns { run, tokenValue, tokenDocId } or throws if all tokens exhausted.
async function startApifyRunWithRotation(actorId, input, accountId, legacyToken, jobId, accountIdStr) {
  const MAX_ROTATIONS = 10; // safety cap
  for (let attempt = 0; attempt < MAX_ROTATIONS; attempt++) {
    const picked = await pickApifyToken(accountId, legacyToken);
    if (!picked) {
      throw new ApifyLimitError("No active Apify tokens available");
    }

    try {
      const run = await startApifyRun(actorId, input, picked.tokenValue);
      return { run, tokenValue: picked.tokenValue, tokenDocId: picked.tokenDocId };
    } catch (err) {
      if (err instanceof ApifyLimitError) {
        console.log(`[deep-scraper] Token ${picked.tokenDocId || "legacy"} hit 403 limit: ${err.message}`);
        if (picked.tokenDocId) {
          await markTokenLimitReached(picked.tokenDocId, err.message);
          emitLog(accountIdStr, jobId, `Apify token "${picked.tokenDocId}" hit limit — rotating to next token`, "warn");
          continue; // try next token
        }
        // Legacy token hit 403 — no rotation possible
        throw err;
      }
      throw err; // non-403 error — don't rotate
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
      // Retry on transient errors (5xx, 429)
      if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
        console.log(`[deep-scraper] Poll got ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`Apify poll failed (${res.status})`);
    } catch (err) {
      if (attempt < MAX_RETRIES && err.message && !err.message.startsWith("Apify poll failed")) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
        console.log(`[deep-scraper] Poll network error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES}):`, err.message);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// Returns the run object for all terminal states (SUCCEEDED, ABORTED, FAILED, TIMED-OUT).
// Returns null only when the job is paused/cancelled by the user.
// Callers should check run.status and handle partial data for non-SUCCEEDED runs.
async function waitForApifyRun(runId, token, jobId, handle) {
  while (true) {
    if (handle.cancelled || handle.paused || handle.skipComments) return null;
    const run = await pollApifyRun(runId, token);
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
      return run;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// Safely get dataset items — returns empty array if dataset is unavailable
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

// ─── Logging helper ──────────────────────────────────────────────────────

function emitLog(accountId, jobId, message, level = "info") {
  emitToAccount(accountId, "deep-scrape:log", {
    jobId,
    message,
    level,
    timestamp: new Date().toISOString(),
  });
}

function emitProgress(accountId, jobId, stats) {
  emitToAccount(accountId, "deep-scrape:progress", { jobId, stats });
}

function emitStatus(accountId, jobId, status, extra = {}) {
  emitToAccount(accountId, "deep-scrape:status", { jobId, status, ...extra });
}

function emitLead(accountId, jobId, username, data) {
  emitToAccount(accountId, "deep-scrape:lead", {
    jobId,
    username,
    fullName: data.fullName || null,
    followersCount: data.followerCount || 0,
    qualified: data.qualified,
    unqualified_reason: data.unqualified_reason || null,
    bio: data.bio || null,
  });
}

// ─── Main job processor (pipeline mode) ──────────────────────────────────
//
// Instead of batch processing (all reels → all comments → all profiles),
// this processes each reel through the full pipeline before moving to the next:
//   For each seed → scrape reels → for each reel → scrape comments → enrich profiles → qualify
//
// Checkpoint/resume:
//   - reel_urls / reel_seeds: accumulated reel URLs and their source seeds
//   - comments_fetched_index: number of reels fully pipeline-processed (comments + profiles + qualify)
//   - commenter_usernames: global set of all commenters seen (for unique count tracking)
//   - On resume, seeds whose reels are already in reel_seeds are skipped for reel scraping
//   - Reels before comments_fetched_index are skipped for pipeline processing
//   - DB dedup handles any partially-processed profiles from the last reel

async function processJob(jobId) {
  const job = await DeepScrapeJob.findById(jobId);
  if (!job) {
    console.error(`[deep-scraper] Job ${jobId} not found`);
    return;
  }

  const accountId = job.account_id.toString();
  const account = await Account.findById(job.account_id).lean();
  const legacyToken = account?.apify_token;

  // Check if any token is available (multi-token or legacy)
  const hasMultiTokens = await ApifyToken.countDocuments({
    account_id: job.account_id,
    status: "active",
  });
  if (!hasMultiTokens && !legacyToken) {
    job.status = "failed";
    job.error = "No Apify tokens configured. Add tokens in Integrations.";
    job.completed_at = new Date();
    await job.save();
    emitStatus(accountId, jobId, "failed", { error: job.error });
    return;
  }

  // currentToken tracks the token being used for waitForApifyRun polling
  let currentToken = null;

  const handle = { cancelled: false, paused: false, skipComments: false };
  activeJobs.set(jobId, handle);

  // Resolve prompt
  let promptText = DEFAULT_QUALIFICATION_PROMPT;
  let openaiClient = null;
  if (job.promptId) {
    const promptDoc = await Prompt.findById(job.promptId).lean();
    if (promptDoc) promptText = promptDoc.promptText;
    const apiKey = account.openai_token || process.env.OPENAI;
    if (apiKey) openaiClient = new OpenAI({ apiKey });
  }

  job.started_at = job.started_at || new Date();
  await job.save();

  try {
    // Accumulated reel data (restored from checkpoint on resume)
    const allReelUrls = [...(job.reel_urls || [])];
    const allReelSeeds = [...(job.reel_seeds || [])];
    const seedsWithReels = new Set(allReelSeeds);

    // Track unique commenters across all reels (restored from checkpoint on resume)
    const seenCommenters = new Set(job.commenter_usernames || []);

    // ── Pipeline: for each seed, scrape reels then process each reel ──
    for (const seed of job.seed_usernames) {
      if (handle.cancelled || handle.paused) break;

      // ── Scrape reels for this seed (skip if already done) ──
      if (!seedsWithReels.has(seed)) {
        job.status = "scraping_reels";
        await job.save();
        emitStatus(accountId, jobId, "scraping_reels");
        emitLog(accountId, jobId, `Scraping reels for @${seed}`);

        const { run, tokenValue: reelToken } = await startApifyRunWithRotation(
          REEL_SCRAPER,
          { username: [seed], resultsLimit: job.reel_limit },
          job.account_id,
          legacyToken,
          jobId,
          accountId,
        );
        currentToken = reelToken;

        job.current_apify_run_id = run.id;
        await job.save();

        emitLog(accountId, jobId, `Apify reel scraper started for @${seed} (${APIFY_MEMORY_MB}MB)`);

        const completedRun = await waitForApifyRun(run.id, currentToken, jobId, handle);
        if (!completedRun) break; // paused or cancelled

        if (completedRun.status !== "SUCCEEDED") {
          emitLog(accountId, jobId, `@${seed}: Apify run ${completedRun.status} — collecting partial data`, "warn");
        }

        const rawReels = await getDatasetItems(completedRun.defaultDatasetId, currentToken);
        if (rawReels.length === 0 && completedRun.status === "FAILED") {
          emitLog(accountId, jobId, `@${seed}: Apify run failed with no data, skipping seed`, "error");
          continue;
        }

        // Filter out error entries from the Apify dataset
        const reels = rawReels.filter((r) => !r.error);
        const errorCount = rawReels.length - reels.length;
        if (errorCount > 0) {
          emitLog(accountId, jobId, `@${seed}: ${errorCount} error entries skipped (${rawReels.filter((r) => r.error).map((r) => r.errorDescription || r.error).join("; ")})`, "warn");
        }

        emitLog(accountId, jobId, `Scraped ${reels.length} reels from @${seed}`, "success");

        if (reels.length > 0) {
          console.log(`[deep-scraper] Sample reel keys:`, Object.keys(reels[0]));
          console.log(`[deep-scraper] Sample reel data:`, JSON.stringify(reels[0]).substring(0, 500));
        }

        for (const reel of reels) {
          const shortCode = reel.shortCode || reel.code || reel.shortcode || reel.short_code || "";
          const rawUrl = reel.url || reel.inputUrl || reel.webUrl || reel.link || reel.permalink || "";
          const reelId = reel.id || shortCode || reel.pk || "";

          let reelUrl = "";
          if (rawUrl && /instagram\.com\/(?:.*\/)?(reel|p)\/([^/?#&]+)/.test(rawUrl)) {
            reelUrl = rawUrl;
          } else if (shortCode) {
            reelUrl = `https://www.instagram.com/p/${shortCode}/`;
          }

          if (!reelUrl) {
            console.log(`[deep-scraper] Could not construct URL for reel:`, { shortCode, rawUrl, reelId });
            emitLog(accountId, jobId, `Warning: Could not construct URL for a reel (id: ${reelId || "unknown"})`, "warn");
          }

          if (reelUrl) {
            allReelUrls.push(reelUrl);
            allReelSeeds.push(seed);
          }

          // Upsert into ResearchPost
          try {
            await ResearchPost.updateOne(
              { reel_id: String(reelId), account_id: job.account_id },
              {
                $set: {
                  competitor_handle: seed,
                  post_type: "reel",
                  reel_url: reelUrl,
                  caption: reel.caption || reel.text || "",
                  likes_count: reel.likesCount ?? reel.diggCount ?? 0,
                  comments_count: reel.commentsCount ?? 0,
                  plays_count: reel.videoPlayCount ?? reel.playCount ?? reel.videoViewCount ?? 0,
                  posted_at: reel.timestamp ? new Date(reel.timestamp) : null,
                  scraped_at: new Date(),
                  deep_scrape_job_id: job._id,
                },
              },
              { upsert: true },
            );
          } catch (err) {
            console.error(`[deep-scraper] ResearchPost upsert error:`, err.message);
          }
        }

        job.stats.reels_scraped += reels.length;
        job.reel_urls = allReelUrls;
        job.reel_seeds = allReelSeeds;
        job.current_apify_run_id = null;
        await job.save();
        emitProgress(accountId, jobId, job.stats);

        console.log(`[deep-scraper] Reels for @${seed}: ${reels.length} URLs collected`);
        if (reels.length > 0 && allReelUrls.filter((_, idx) => allReelSeeds[idx] === seed).length === 0) {
          emitLog(accountId, jobId, `Warning: ${reels.length} reels scraped for @${seed} but no valid URLs constructed. Check server logs.`, "error");
        }
      } else {
        emitLog(accountId, jobId, `Reels for @${seed} already scraped, resuming pipeline`);
      }

      if (handle.cancelled || handle.paused) break;

      // ── Pipeline: process each reel belonging to this seed ──
      for (let i = 0; i < allReelUrls.length; i++) {
        if (allReelSeeds[i] !== seed) continue;
        if (i < (job.comments_fetched_index || 0)) continue; // Already processed
        if (handle.cancelled || handle.paused || handle.skipComments) break;

        const reelUrl = allReelUrls[i];

        // Validate URL
        if (!/instagram\.com\/(?:.*\/)?(reel|p)\//.test(reelUrl)) {
          emitLog(accountId, jobId, `Skipping invalid URL: ${reelUrl}`, "warn");
          job.comments_fetched_index = i + 1;
          await job.save();
          continue;
        }

        // ── 1. Scrape comments for this reel ──
        job.status = "scraping_comments";
        await job.save();
        emitStatus(accountId, jobId, "scraping_comments");
        emitLog(accountId, jobId, `Scraping comments for reel ${i + 1}/${allReelUrls.length} (@${seed})`);

        const { run: commentRun, tokenValue: commentToken } = await startApifyRunWithRotation(
          COMMENT_SCRAPER,
          { directUrls: [reelUrl], resultsPerPost: job.comment_limit },
          job.account_id,
          legacyToken,
          jobId,
          accountId,
        );
        currentToken = commentToken;

        job.current_apify_run_id = commentRun.id;
        await job.save();

        const completedCommentRun = await waitForApifyRun(commentRun.id, currentToken, jobId, handle);
        if (!completedCommentRun) break;

        if (completedCommentRun.status !== "SUCCEEDED") {
          emitLog(accountId, jobId, `Reel ${i + 1}: comment scraper ${completedCommentRun.status} — collecting partial data`, "warn");
        }

        const comments = await getDatasetItems(completedCommentRun.defaultDatasetId, currentToken);
        console.log(`[deep-scraper] Reel ${i + 1}: got ${comments.length} comments`);

        if (comments.length === 0 && completedCommentRun.status === "FAILED") {
          emitLog(accountId, jobId, `Reel ${i + 1}: comment scraper failed with no data, skipping reel`, "error");
          job.comments_fetched_index = i + 1;
          await job.save();
          continue;
        }

        // Find the ResearchPost for this reel
        const researchPost = await ResearchPost.findOne({
          reel_url: reelUrl,
          account_id: job.account_id,
        }).lean();

        // Save comments + collect unique commenters
        const reelCommenters = new Set();
        const commentDocs = [];
        for (const c of comments) {
          const username = c.ownerUsername || c.username || c.owner?.username || "";
          if (!username) continue;
          reelCommenters.add(username);
          commentDocs.push({
            account_id: job.account_id,
            research_post_id: researchPost?._id || null,
            reel_url: reelUrl,
            commenter_username: username,
            comment_text: c.text || c.comment || "",
            scraped_at: new Date(),
            deep_scrape_job_id: job._id,
          });
        }

        if (commentDocs.length > 0) {
          try {
            await ResearchComment.insertMany(commentDocs, { ordered: false });
          } catch (err) {
            if (err.code !== 11000) {
              console.error(`[deep-scraper] Comment insert error:`, err.message);
            }
          }
        }

        // Update unique commenter tracking
        for (const u of reelCommenters) seenCommenters.add(u);

        job.stats.comments_scraped += comments.length;
        job.stats.unique_commenters = seenCommenters.size;
        emitLog(accountId, jobId, `Reel ${i + 1}: ${comments.length} comments, ${reelCommenters.size} commenters`);

        // ── 2. Dedup commenters against already-processed leads ──
        let usernamesToProcess = [...reelCommenters];
        if (!job.force_reprocess) {
          const existing = await OutboundLead.find(
            {
              account_id: job.account_id,
              username: { $in: usernamesToProcess },
              $or: [{ ai_processed: true }, { unqualified_reason: "low_followers" }],
            },
            { username: 1 },
          ).lean();

          const existingSet = new Set(existing.map((e) => e.username));
          const skippedCount = usernamesToProcess.filter((u) => existingSet.has(u)).length;
          usernamesToProcess = usernamesToProcess.filter((u) => !existingSet.has(u));

          if (skippedCount > 0) {
            job.stats.skipped_existing += skippedCount;
            emitLog(accountId, jobId, `Skipped ${skippedCount} already-processed users`);
          }
        }

        if (usernamesToProcess.length > 0) {
          // ── 3. Enrich profiles + qualify ──
          job.status = "scraping_profiles";
          await job.save();
          emitStatus(accountId, jobId, "scraping_profiles");

          const BATCH_SIZE = 50;
          for (let batchStart = 0; batchStart < usernamesToProcess.length; batchStart += BATCH_SIZE) {
            if (handle.cancelled || handle.paused) break;

            const batch = usernamesToProcess.slice(batchStart, batchStart + BATCH_SIZE);
            emitLog(
              accountId,
              jobId,
              `Enriching profiles ${batchStart + 1}-${batchStart + batch.length} of ${usernamesToProcess.length} (reel ${i + 1})`,
            );

            const { run: profileRun, tokenValue: profileToken } = await startApifyRunWithRotation(
              PROFILE_SCRAPER,
              { usernames: batch },
              job.account_id,
              legacyToken,
              jobId,
              accountId,
            );
            currentToken = profileToken;

            job.current_apify_run_id = profileRun.id;
            await job.save();

            const completedProfileRun = await waitForApifyRun(profileRun.id, currentToken, jobId, handle);
            if (!completedProfileRun) break;

            if (completedProfileRun.status !== "SUCCEEDED") {
              emitLog(accountId, jobId, `Profile batch: Apify run ${completedProfileRun.status} — collecting partial data`, "warn");
            }

            const profiles = await getDatasetItems(completedProfileRun.defaultDatasetId, currentToken);

            if (profiles.length === 0 && completedProfileRun.status === "FAILED") {
              emitLog(accountId, jobId, `Profile batch failed with no data, skipping ${batch.length} users`, "error");
              continue;
            }

            // Process each profile
            for (const profile of profiles) {
              if (handle.cancelled || handle.paused) break;

              const username = profile.username || "";
              if (!username) continue;

              const followerCount = profile.followersCount ?? profile.follower_count ?? 0;
              const bio = profile.biography ?? profile.bio ?? "";
              const postsCount = profile.postsCount ?? profile.mediaCount ?? profile.media_count ?? 0;
              const isPrivate = profile.isPrivate ?? profile.is_private ?? false;
              const isVerified = profile.isVerified ?? profile.is_verified ?? false;
              const externalUrl = profile.externalUrl ?? profile.external_url ?? null;
              const fullName = profile.fullName ?? profile.full_name ?? null;

              job.stats.profiles_scraped++;

              const userSeeds = [seed];

              // Follower filter
              if (followerCount < job.min_followers) {
                await upsertLead(job, username, {
                  fullName, bio, followerCount, postsCount, isPrivate, isVerified, externalUrl,
                  qualified: false, unqualified_reason: "low_followers", ai_processed: false,
                }, userSeeds);
                job.stats.filtered_low_followers++;
                emitLead(accountId, jobId, username, { fullName, bio, followerCount, qualified: false, unqualified_reason: "low_followers" });
                emitLog(accountId, jobId, `@${username} → Low followers (${followerCount.toLocaleString()}) → Filtered`, "warn");
              } else if (openaiClient && job.promptId) {
                // AI qualification
                job.stats.sent_to_ai++;

                try {
                  const result = await qualifyBio(bio, promptText, openaiClient);
                  const isQualified = result === "Qualified";

                  await upsertLead(job, username, {
                    fullName, bio, followerCount, postsCount, isPrivate, isVerified, externalUrl,
                    qualified: isQualified,
                    unqualified_reason: isQualified ? null : "ai_rejected",
                    ai_processed: true,
                    promptId: job.promptId,
                    promptLabel: job.promptLabel,
                  }, userSeeds);

                  emitLead(accountId, jobId, username, { fullName, bio, followerCount, qualified: isQualified, unqualified_reason: isQualified ? null : "ai_rejected" });
                  if (isQualified) {
                    job.stats.qualified++;
                    emitLog(accountId, jobId, `@${username} → Qualified`, "success");
                  } else {
                    job.stats.rejected++;
                    emitLog(accountId, jobId, `@${username} → Rejected by AI`, "warn");
                  }
                } catch (err) {
                  console.error(`[deep-scraper] AI error for @${username}:`, err.message);
                  await upsertLead(job, username, {
                    fullName, bio, followerCount, postsCount, isPrivate, isVerified, externalUrl,
                    qualified: null, unqualified_reason: null, ai_processed: false,
                  }, userSeeds);
                  emitLog(accountId, jobId, `@${username} → AI error, saved without qualification`, "error");
                }
              } else {
                // No prompt → save as qualified by default
                await upsertLead(job, username, {
                  fullName, bio, followerCount, postsCount, isPrivate, isVerified, externalUrl,
                  qualified: true, unqualified_reason: null, ai_processed: false,
                }, userSeeds);
                job.stats.qualified++;
                emitLead(accountId, jobId, username, { fullName, bio, followerCount, qualified: true, unqualified_reason: null });
                emitLog(accountId, jobId, `@${username} → Saved (${followerCount.toLocaleString()} followers)`);
              }

              // Save progress every 10 profiles
              if (job.stats.profiles_scraped % 10 === 0) {
                await job.save();
                emitProgress(accountId, jobId, job.stats);
              }
            }
          }
        }

        if (handle.cancelled || handle.paused) break;

        // Mark this reel as fully pipeline-processed
        job.comments_fetched_index = i + 1;
        job.commenter_usernames = [...seenCommenters];
        job.current_apify_run_id = null;
        await job.save();
        emitProgress(accountId, jobId, job.stats);
        emitLog(
          accountId,
          jobId,
          `Reel ${i + 1}/${allReelUrls.length} pipeline complete — ${usernamesToProcess.length} new profiles processed`,
          "success",
        );
      }
    }

    // Handle interrupts
    if (handle.cancelled || handle.paused) {
      await handleInterrupt(job, handle, accountId, jobId, currentToken || legacyToken);
      return;
    }

    if (handle.skipComments) {
      if (job.current_apify_run_id) {
        await abortApifyRun(job.current_apify_run_id, currentToken || legacyToken);
      }
      job.comments_skipped = true;
      job.current_apify_run_id = null;
      handle.skipComments = false;
      emitLog(accountId, jobId, `Pipeline skipped — completing with current results`, "warn");
    }

    // ── Completed ────────────────────────────────────────────────────────
    job.status = "completed";
    job.completed_at = new Date();
    job.current_apify_run_id = null;
    if (job.is_recurring && job.repeat_interval_days) {
      job.next_run_at = new Date(Date.now() + job.repeat_interval_days * 24 * 60 * 60 * 1000);
    }
    await job.save();

    emitStatus(accountId, jobId, "completed");
    emitProgress(accountId, jobId, job.stats);
    emitLog(
      accountId,
      jobId,
      `Job completed — ${job.stats.qualified} qualified, ${job.stats.filtered_low_followers} filtered, ${job.stats.rejected} rejected`,
      "success",
    );
    console.log(
      `[deep-scraper] Job ${jobId} complete. Q:${job.stats.qualified} F:${job.stats.filtered_low_followers} R:${job.stats.rejected}`,
    );
  } catch (err) {
    if (!handle.paused && !handle.cancelled) {
      // 403 / token exhaustion → pause (not fail) so user can add tokens and resume
      if (err instanceof ApifyLimitError) {
        console.log(`[deep-scraper] Job ${jobId} paused — Apify limit: ${err.message}`);
        if (job.current_apify_run_id && currentToken) {
          await abortApifyRun(job.current_apify_run_id, currentToken).catch(() => {});
        }
        job.status = "paused";
        job.error = "Paused – All Apify tokens exhausted (monthly limit reached). Add a new token or wait for limit reset, then resume.";
        job.current_apify_run_id = null;
        await job.save();
        emitStatus(accountId, jobId, "paused", { error: job.error });
        emitLog(accountId, jobId, job.error, "error");
      } else {
        console.error(`[deep-scraper] Job ${jobId} failed:`, err.message);
        job.status = "failed";
        job.error = err.message;
        job.completed_at = new Date();
        await job.save();
        emitStatus(accountId, jobId, "failed", { error: err.message });
        emitLog(accountId, jobId, `Job failed: ${err.message}`, "error");
      }
    }
  }

  activeJobs.delete(jobId);
}

// ─── Upsert OutboundLead ─────────────────────────────────────────────────

async function upsertLead(job, username, data, seeds) {
  // seeds = specific seed(s) this commenter was found on
  // Fallback to all job seeds for backwards compat
  const leadSeeds = seeds && seeds.length > 0 ? seeds : job.seed_usernames;
  const sourceStr = leadSeeds.map((u) => "@" + u.replace(/^@/, "")).join(", ");

  const update = {
    $set: {
      followingKey: `${username}::deep-scrape`,
      fullName: data.fullName || null,
      profileLink: `https://www.instagram.com/${username}/`,
      isVerified: data.isVerified || false,
      followersCount: data.followerCount || 0,
      bio: data.bio || null,
      postsCount: data.postsCount || 0,
      externalUrl: data.externalUrl || null,
      source: sourceStr,
      scrapeDate: new Date(),
      qualified: data.qualified,
      unqualified_reason: data.unqualified_reason || null,
      ai_processed: data.ai_processed || false,
      metadata: {
        source: sourceStr,
        executionId: `deep-scrape-${job._id}`,
        syncedAt: new Date(),
      },
    },
    $addToSet: {
      source_seeds: { $each: leadSeeds.map((u) => u.replace(/^@/, "")) },
    },
  };

  if (data.promptId) {
    update.$set.promptId = data.promptId;
    update.$set.promptLabel = data.promptLabel;
  }

  const result = await OutboundLead.updateOne(
    { username, account_id: job.account_id },
    update,
    { upsert: true },
  );

  if (result.upsertedCount > 0) {
    job.stats.leads_created++;
  } else {
    job.stats.leads_updated++;
  }
}

// ─── Pause / Cancel ──────────────────────────────────────────────────────

async function handleInterrupt(job, handle, accountId, jobId, apifyToken) {
  // Abort any running Apify run
  if (job.current_apify_run_id) {
    await abortApifyRun(job.current_apify_run_id, apifyToken);
    job.current_apify_run_id = null;
  }

  if (handle.cancelled) {
    job.status = "cancelled";
    job.completed_at = new Date();
    await job.save();
    emitStatus(accountId, jobId, "cancelled");
    emitLog(accountId, jobId, "Job cancelled", "warn");
    console.log(`[deep-scraper] Job ${jobId} cancelled.`);
  } else if (handle.paused) {
    job.status = "paused";
    await job.save();
    emitStatus(accountId, jobId, "paused");
    emitLog(accountId, jobId, "Job paused", "warn");
    console.log(`[deep-scraper] Job ${jobId} paused.`);
  }

  activeJobs.delete(jobId);
}

function cancelJob(jobId) {
  const handle = activeJobs.get(jobId);
  if (handle) {
    handle.cancelled = true;
    return true;
  }
  return false;
}

function pauseJob(jobId) {
  const handle = activeJobs.get(jobId);
  if (handle) {
    handle.paused = true;
    return true;
  }
  return false;
}

function skipComments(jobId) {
  const handle = activeJobs.get(jobId);
  if (handle) {
    handle.skipComments = true;
    return true;
  }
  return false;
}

function isJobRunning(jobId) {
  return activeJobs.has(jobId);
}

module.exports = {
  processJob,
  cancelJob,
  pauseJob,
  skipComments,
  isJobRunning,
};

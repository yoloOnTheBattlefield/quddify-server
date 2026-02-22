const { spawn, execSync } = require("child_process");
const path = require("path");
const readline = require("readline");
const OpenAI = require("openai");
const ScrapeJob = require("../models/ScrapeJob");
const OutboundLead = require("../models/OutboundLead");
const Account = require("../models/Account");
const Prompt = require("../models/Prompt");
const { qualifyBio, DEFAULT_QUALIFICATION_PROMPT } = require("./uploadService");

const PYTHON_SCRIPT = path.join(__dirname, "..", "scripts", "ig_scraper.py");

// Resolve absolute python3 path at startup to avoid PATH issues
let PYTHON_BIN = "python3";
try {
  PYTHON_BIN = execSync("which python3").toString().trim();
  console.log(`[scraper] Using Python: ${PYTHON_BIN}`);
} catch {
  console.warn("[scraper] Could not resolve python3 path, using 'python3'");
}

let io = null;
const activeJobs = new Map(); // jobId -> { process, cancelled, paused }

function init(socketIo) {
  io = socketIo;
}

function emit(accountId, event, data) {
  if (io) io.to(`account:${accountId}`).emit(event, data);
}

// ============================================
// Quick session validation (Node-based, kept for the validate-session endpoint)
// ============================================

async function validateSession(credentials) {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "x-csrftoken": credentials.csrf_token,
    "x-ig-app-id": "936619743392459",
    "x-ig-www-claim": "0",
    "x-requested-with": "XMLHttpRequest",
    accept: "*/*",
    origin: "https://www.instagram.com",
    referer: "https://www.instagram.com/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    cookie: `sessionid=${credentials.session_id}; csrftoken=${credentials.csrf_token}; ds_user_id=${credentials.ds_user_id}`,
  };

  try {
    const resp = await fetch(
      "https://i.instagram.com/api/v1/accounts/current_user/?edit=true",
      { headers, signal: AbortSignal.timeout(15000) },
    );
    if (resp.status === 200) {
      const data = await resp.json();
      return { valid: true, username: data?.user?.username };
    }
    if (resp.status === 401) {
      return {
        valid: false,
        reason: "Session expired (401). Update your Instagram cookies.",
      };
    }
    if (resp.status === 429 || resp.status === 400) {
      return { valid: true, username: null, rateLimited: true };
    }
    return {
      valid: false,
      reason: `Unexpected status ${resp.status} during session check.`,
    };
  } catch (err) {
    return { valid: false, reason: `Session check failed: ${err.message}` };
  }
}

// ============================================
// Main job processor — spawns Python script
// ============================================

async function processJob(jobId, credentials) {
  const job = await ScrapeJob.findById(jobId);
  if (!job) {
    console.error(`[scraper] Job ${jobId} not found`);
    return;
  }

  // If no credentials passed (e.g. recovery), load from account
  if (!credentials) {
    const account = await Account.findById(job.account_id).lean();
    const s = account?.ig_session;
    if (!s || !s.session_id || !s.csrf_token || !s.ds_user_id) {
      job.status = "failed";
      job.error =
        "Instagram session not configured on account. Set credentials in integrations.";
      job.completed_at = new Date();
      await job.save();
      return;
    }
    credentials = {
      session_id: s.session_id,
      csrf_token: s.csrf_token,
      ds_user_id: s.ds_user_id,
    };
  }

  const accountId = job.account_id.toString();

  // Load account for proxy + openai token
  const accountDoc = await Account.findById(job.account_id, "openai_token ig_proxy").lean();

  // Resolve prompt + filters upfront (before spawning Python)
  let promptText = DEFAULT_QUALIFICATION_PROMPT;
  let filters = {};
  let openaiClient = null;

  if (job.promptId) {
    const promptDoc = await Prompt.findById(job.promptId).lean();
    if (promptDoc) {
      promptText = promptDoc.promptText;
      filters = promptDoc.filters || {};
    }
    const apiKey = accountDoc?.openai_token || process.env.OPENAI;
    openaiClient = new OpenAI({ apiKey });
  }

  const minFollowers = filters.minFollowers ?? 0;
  const minPosts = filters.minPosts ?? 0;
  const excludePrivate = filters.excludePrivate ?? true;
  const bioRequired = filters.bioRequired ?? false;

  // Determine phase for Python
  const phase = job.followers_done ? "bios" : "full";

  // Build config for Python stdin
  const config = {
    session_id: credentials.session_id,
    csrf_token: credentials.csrf_token,
    ds_user_id: credentials.ds_user_id,
    target_username: job.target_username,
    max_followers: job.max_followers,
    phase,
    cursor: job.cursor,
    target_user_id: job.target_user_id,
    followers:
      phase === "bios"
        ? job.followers.map((f) => ({
            pk: f.pk,
            username: f.username,
            full_name: f.full_name,
          }))
        : [],
    start_bio_index: job.bios_fetched,
    proxy: accountDoc?.ig_proxy || "http://slngeoov:76rk3hbr0rmv@198.23.239.134:6540",
  };

  // Spawn Python
  const proc = spawn(PYTHON_BIN, [PYTHON_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const handle = { process: proc, cancelled: false, paused: false };
  activeJobs.set(jobId, handle);

  // Send config via stdin
  proc.stdin.write(JSON.stringify(config));
  proc.stdin.end();

  // Update job status
  job.status = job.followers_done ? "fetching_bios" : "collecting_followers";
  job.started_at = job.started_at || new Date();
  await job.save();
  emit(accountId, "scrape:status", { jobId, status: job.status });

  // Log stderr (Python errors/warnings)
  let stderrBuf = "";
  proc.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    // Log complete lines
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      if (line.trim()) console.log(`[scraper:py] ${line}`);
    }
  });

  // Read JSON lines from Python stdout
  const rl = readline.createInterface({ input: proc.stdout });

  try {
    for await (const line of rl) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        console.log(`[scraper:py] ${line}`);
        continue;
      }

      switch (event.event) {
        case "session_valid":
          console.log(
            `[scraper] Session valid (logged in as @${event.username})`,
          );
          break;

        case "user_resolved":
          job.target_user_id = event.user_id;
          await job.save();
          console.log(`[scraper] User ID: ${event.user_id}`);
          break;

        case "phase":
          job.status = event.phase;
          await job.save();
          emit(accountId, "scrape:status", { jobId, status: event.phase });
          break;

        case "followers_page":
          for (const u of event.users) {
            job.followers.push({
              pk: u.pk,
              username: u.username,
              full_name: u.full_name,
            });
          }
          job.cursor = event.cursor;
          job.request_count++;
          await job.save();
          emit(accountId, "scrape:progress", {
            jobId,
            phase: "followers",
            collected: job.followers.length,
          });
          break;

        case "followers_done":
          job.followers_done = true;
          job.cursor = null;
          await job.save();
          console.log(
            `[scraper] Done collecting ${job.followers.length} followers`,
          );
          break;

        case "bio_result": {
          job.request_count++;
          const bioData = event.bio_data;

          // Apply filters
          const passesFilters =
            bioData.follower_count >= minFollowers &&
            bioData.media_count >= minPosts &&
            (!excludePrivate || !bioData.is_private) &&
            (!bioRequired || bioData.biography);

          if (!passesFilters) {
            job.leads_filtered++;
            job.bios_fetched = event.index + 1;
            if ((event.index + 1) % 10 === 0) await job.save();
            break;
          }

          // OpenAI qualification
          if (openaiClient) {
            try {
              const result = await qualifyBio(
                bioData.biography,
                promptText,
                openaiClient,
              );
              if (result !== "Qualified") {
                job.leads_unqualified++;
                job.bios_fetched = event.index + 1;
                if ((event.index + 1) % 10 === 0) await job.save();
                break;
              }
            } catch (err) {
              console.error(
                `[scraper] OpenAI error for @${event.username}, skipping:`,
                err.message,
              );
              job.leads_skipped++;
              job.bios_fetched = event.index + 1;
              if ((event.index + 1) % 10 === 0) await job.save();
              break;
            }
          }

          // Upsert OutboundLead
          const f = job.followers[event.index];
          const updateResult = await OutboundLead.updateOne(
            { username: event.username, account_id: job.account_id },
            {
              $set: {
                followingKey: `${event.username}::${job.target_username}`,
                fullName: f?.full_name || null,
                profileLink: `https://www.instagram.com/${event.username}/`,
                isVerified: bioData.is_verified,
                followersCount: bioData.follower_count,
                bio: bioData.biography || null,
                postsCount: bioData.media_count,
                externalUrl: bioData.external_url || null,
                source: job.target_username,
                scrapeDate: new Date(),
                promptId: job.promptId || null,
                promptLabel: job.promptLabel || null,
                metadata: {
                  source: "scraper",
                  executionId: `scrape-${jobId}`,
                  syncedAt: new Date(),
                },
              },
            },
            { upsert: true },
          );

          if (updateResult.upsertedCount > 0) {
            job.leads_created++;
          } else {
            job.leads_updated++;
          }

          job.bios_fetched = event.index + 1;

          if (
            (event.index + 1) % 10 === 0 ||
            event.index === job.followers.length - 1
          ) {
            await job.save();
            emit(accountId, "scrape:progress", {
              jobId,
              phase: "bios",
              done: job.bios_fetched,
              total: job.followers.length,
              created: job.leads_created,
              updated: job.leads_updated,
              filtered: job.leads_filtered,
              unqualified: job.leads_unqualified,
              skipped: job.leads_skipped,
            });
          }
          break;
        }

        case "bio_skip":
          job.leads_skipped++;
          job.bios_fetched = event.index + 1;
          job.request_count++;
          if ((event.index + 1) % 10 === 0) await job.save();
          break;

        case "rate_limited":
          console.log(
            `[scraper] Rate limited on ${event.context}. Waiting ${event.wait}s`,
          );
          emit(accountId, "scrape:progress", {
            jobId,
            phase: "rate_limited",
            retryIn: event.wait,
            attempt: event.attempt || 1,
            maxRetries: 5,
          });
          break;

        case "error":
          console.log(
            `[scraper] Error: ${event.message} (${event.context})`,
          );
          break;

        case "fatal":
          throw new Error(event.message);

        case "terminated":
          // Python exited due to SIGTERM — cancel/pause handled after loop
          break;

        case "done":
          job.status = "completed";
          job.completed_at = new Date();
          await job.save();
          emit(accountId, "scrape:status", {
            jobId,
            status: "completed",
            leads_created: job.leads_created,
            leads_updated: job.leads_updated,
            leads_filtered: job.leads_filtered,
            leads_unqualified: job.leads_unqualified,
            total_followers: job.followers.length,
          });
          console.log(
            `[scraper] Job ${jobId} complete. ${job.leads_created} created, ${job.leads_updated} updated, ${job.leads_filtered} filtered, ${job.leads_unqualified} unqualified.`,
          );
          break;
      }
    }
  } catch (err) {
    // Don't mark as failed if the process was intentionally paused or cancelled
    if (!handle.paused && !handle.cancelled) {
      console.error(`[scraper] Job ${jobId} failed:`, err.message);
      job.status = "failed";
      job.error = err.message;
      job.completed_at = new Date();
      await job.save();
      emit(accountId, "scrape:status", {
        jobId,
        status: "failed",
        error: err.message,
      });
    }
  }

  // Wait for Python process to fully exit
  await new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.on("close", resolve);
  });

  // Handle cancel/pause (process was killed, no "done" event)
  if (handle.cancelled && job.status !== "failed" && job.status !== "completed") {
    job.status = "cancelled";
    job.completed_at = new Date();
    await job.save();
    emit(accountId, "scrape:status", { jobId, status: "cancelled" });
    console.log(`[scraper] Job ${jobId} cancelled.`);
  } else if (handle.paused && job.status !== "failed" && job.status !== "completed") {
    job.status = "paused";
    await job.save();
    emit(accountId, "scrape:status", { jobId, status: "paused" });
    console.log(`[scraper] Job ${jobId} paused.`);
  } else if (
    job.status !== "completed" &&
    job.status !== "failed" &&
    job.status !== "cancelled" &&
    job.status !== "paused"
  ) {
    // Python exited unexpectedly without sending done/fatal
    job.status = "failed";
    job.error = "Scraper process exited unexpectedly.";
    job.completed_at = new Date();
    await job.save();
    emit(accountId, "scrape:status", {
      jobId,
      status: "failed",
      error: job.error,
    });
  }

  activeJobs.delete(jobId);
}

function cancelJob(jobId) {
  const handle = activeJobs.get(jobId);
  if (handle) {
    handle.cancelled = true;
    if (handle.process && handle.process.exitCode === null) {
      handle.process.kill("SIGTERM");
    }
    return true;
  }
  return false;
}

function pauseJob(jobId) {
  const handle = activeJobs.get(jobId);
  if (handle) {
    handle.paused = true;
    if (handle.process && handle.process.exitCode === null) {
      handle.process.kill("SIGTERM");
    }
    return true;
  }
  return false;
}

function isJobRunning(jobId) {
  return activeJobs.has(jobId);
}

// Recover stuck jobs on startup (credentials loaded from account)
async function recoverJobs() {
  const stuck = await ScrapeJob.find({
    status: { $in: ["collecting_followers", "fetching_bios"] },
  });

  for (const job of stuck) {
    console.log(
      `[scraper] Recovering stuck job ${job._id} for @${job.target_username}`,
    );
    processJob(job._id.toString());
  }
}

module.exports = {
  init,
  processJob,
  cancelJob,
  pauseJob,
  isJobRunning,
  recoverJobs,
  validateSession,
};

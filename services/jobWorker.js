const OpenAI = require("openai");
const QualificationJob = require("../models/QualificationJob");
const Account = require("../models/Account");
const OutboundLead = require("../models/OutboundLead");
const IgAccount = require("../models/IgAccount");
const Prompt = require("../models/Prompt");
const { getBuffers, clearBuffers } = require("../utils/fileStore");
const {
  parseFilename,
  parseXlsx,
  qualifyBio,
  DEFAULT_QUALIFICATION_PROMPT,
} = require("./uploadService");
const { toNumber, toDate, toBoolean } = require("../utils/normalize");

let io = null;

function init(socketIo) {
  io = socketIo;
}

function emitToAccount(accountId, event, data) {
  if (io) {
    io.to(`account:${accountId}`).emit(event, data);
  }
}

async function processJob(jobId) {
  const job = await QualificationJob.findById(jobId);
  if (!job) {
    console.error(`[jobWorker] Job ${jobId} not found`);
    return;
  }

  const accountId = job.account_id.toString();

  // Mark job as running
  job.status = "running";
  job.startedAt = new Date();
  await job.save();
  emitToAccount(accountId, "job:started", { jobId, status: "running" });

  const fileBuffers = getBuffers(jobId);
  if (!fileBuffers) {
    job.status = "failed";
    job.error = "File buffers not found (server may have restarted)";
    job.completedAt = new Date();
    await job.save();
    emitToAccount(accountId, "job:failed", { jobId, error: job.error });
    return;
  }

  // Resolve account's OpenAI token (fall back to env var)
  const account = await Account.findById(job.account_id, "openai_token").lean();
  const apiKey = (account && account.openai_token) || process.env.OPENAI;
  const openaiClient = new OpenAI({ apiKey });

  // Resolve prompt once for the entire job
  let promptText = DEFAULT_QUALIFICATION_PROMPT;
  let promptFilters = {};
  if (job.promptId) {
    const promptDoc = await Prompt.findById(job.promptId).lean();
    if (promptDoc) {
      promptText = promptDoc.promptText;
      promptFilters = promptDoc.filters || {};
    }
  }

  const minFollowers = promptFilters.minFollowers ?? 40000;
  const minPosts = promptFilters.minPosts ?? 10;
  const excludePrivate = promptFilters.excludePrivate ?? true;
  const verifiedOnly = promptFilters.verifiedOnly ?? false;
  const bioRequired = promptFilters.bioRequired ?? false;

  try {
    for (let fileIndex = 0; fileIndex < job.files.length; fileIndex++) {
      // Check cancellation before each file
      const freshJob = await QualificationJob.findById(
        jobId,
        "cancelRequested",
      ).lean();
      if (freshJob.cancelRequested) {
        job.status = "cancelled";
        job.completedAt = new Date();
        await job.save();
        emitToAccount(accountId, "job:completed", {
          jobId,
          status: "cancelled",
          totalQualified: job.qualifiedLeads,
          totalFailed: job.failedLeads,
        });
        clearBuffers(jobId);
        return;
      }

      const fileEntry = job.files[fileIndex];
      const fileBuffer = fileBuffers[fileIndex];

      fileEntry.status = "processing";
      await job.save();
      emitToAccount(accountId, "job:file:started", {
        jobId,
        fileIndex,
        filename: fileEntry.filename,
      });

      try {
        // Parse filename
        const { sourceAccount, scrapeDate } = parseFilename(
          fileEntry.filename,
        );
        fileEntry.sourceAccount = sourceAccount;
        fileEntry.scrapeDate = scrapeDate;

        // Parse XLSX
        const rows = parseXlsx(fileBuffer.buffer);
        fileEntry.totalRows = rows.length;

        // Get existing usernames for deduplication
        const existingOutboundLeads = await OutboundLead.find(
          { source: sourceAccount },
          { username: 1 },
        ).lean();
        const existingUsernames = new Set(
          existingOutboundLeads.map((f) => f.username),
        );

        // Filter rows using prompt filters (or defaults)
        const filtered = rows.filter((row) => {
          const followers = toNumber(row["Followers count"]);
          const posts = toNumber(row["Posts count"]);
          const isPrivate = String(row["Is private"] || "")
            .trim()
            .toUpperCase();
          const isVerified = String(row["Is verified"] || "")
            .trim()
            .toUpperCase();
          const username = String(row["Username"] || "").trim();
          const bio = (row["Biography"] || "").trim();

          if (!username || existingUsernames.has(username)) return false;
          if (followers === null || followers < minFollowers) return false;
          if (posts === null || posts <= minPosts) return false;
          if (excludePrivate && isPrivate !== "NO") return false;
          if (verifiedOnly && isVerified !== "YES") return false;
          if (bioRequired && !bio) return false;

          return true;
        });

        fileEntry.filteredRows = filtered.length;
        job.totalLeads += filtered.length;
        await job.save();

        // Process each filtered row
        const executionId = `job-${jobId}-file-${fileIndex}`;
        const now = new Date();
        let pendingDbUpdate = 0;

        for (let rowIdx = 0; rowIdx < filtered.length; rowIdx++) {
          // Check cancellation every 10 rows
          if (rowIdx % 10 === 0 && rowIdx > 0) {
            const cancelCheck = await QualificationJob.findById(
              jobId,
              "cancelRequested",
            ).lean();
            if (cancelCheck.cancelRequested) {
              await job.save();
              job.status = "cancelled";
              job.completedAt = new Date();
              await job.save();
              emitToAccount(accountId, "job:completed", {
                jobId,
                status: "cancelled",
                totalQualified: job.qualifiedLeads,
                totalFailed: job.failedLeads,
              });
              clearBuffers(jobId);
              return;
            }
          }

          const row = filtered[rowIdx];
          const bio = row["Biography"] || "";

          let qualification;
          try {
            qualification = await qualifyBio(bio, promptText, openaiClient);
          } catch (err) {
            console.error(
              `OpenAI error for ${row["Username"]}, skipping:`,
              err.message,
            );
            fileEntry.failedRows++;
            job.failedLeads++;
            fileEntry.processedRows++;
            job.processedLeads++;
            pendingDbUpdate++;

            if (pendingDbUpdate >= 10) {
              await job.save();
              pendingDbUpdate = 0;
              emitToAccount(accountId, "job:progress", {
                jobId,
                fileIndex,
                processedRows: fileEntry.processedRows,
                totalFilteredRows: fileEntry.filteredRows,
                qualifiedCount: fileEntry.qualifiedCount,
                failedRows: fileEntry.failedRows,
              });
            }
            continue;
          }

          if (qualification === "Qualified") {
            const username = String(row["Username"] || "").trim();
            const followingKey = `${username}::${sourceAccount}`;

            await OutboundLead.findOneAndUpdate(
              { followingKey },
              {
                $set: {
                  username,
                  fullName: row["Full name"] || null,
                  profileLink: row["Profile link"] || null,
                  isVerified: toBoolean(row["Is verified"]),
                  followersCount: toNumber(row["Followers count"]),
                  bio: row["Biography"] || null,
                  postsCount: toNumber(row["Posts count"]),
                  externalUrl: row["External url"] || null,
                  email: row["Public email"] || row["Email"] || null,
                  source: sourceAccount,
                  scrapeDate: toDate(scrapeDate),
                  ig: row["IG"] || null,
                  qualified: true,
                  promptId: job.promptId || null,
                  promptLabel: job.promptLabel || null,
                  isMessaged: toBoolean(row["Messaged?"]),
                  dmDate: toDate(row["DM Date"]),
                  message: row["Message"] || null,
                  metadata: {
                    source: "nodejs",
                    executionId,
                    syncedAt: now,
                  },
                },
              },
              { upsert: true, new: true },
            );

            fileEntry.qualifiedCount++;
            job.qualifiedLeads++;
          }

          fileEntry.processedRows++;
          job.processedLeads++;
          pendingDbUpdate++;

          // Throttled progress update every 10 rows
          if (pendingDbUpdate >= 10) {
            await job.save();
            pendingDbUpdate = 0;
            emitToAccount(accountId, "job:progress", {
              jobId,
              fileIndex,
              processedRows: fileEntry.processedRows,
              totalFilteredRows: fileEntry.filteredRows,
              qualifiedCount: fileEntry.qualifiedCount,
              failedRows: fileEntry.failedRows,
            });
          }
        }

        // Flush remaining pending updates for this file
        if (pendingDbUpdate > 0) {
          await job.save();
          emitToAccount(accountId, "job:progress", {
            jobId,
            fileIndex,
            processedRows: fileEntry.processedRows,
            totalFilteredRows: fileEntry.filteredRows,
            qualifiedCount: fileEntry.qualifiedCount,
            failedRows: fileEntry.failedRows,
          });
        }

        // Update IgAccount stats
        const accountKey = `instagram::${sourceAccount}`;
        await IgAccount.findOneAndUpdate(
          { accountKey },
          {
            $inc: { scrapedCount: fileEntry.totalRows },
            $set: {
              name: sourceAccount,
              lastScraped: toDate(scrapeDate),
              metadata: { source: "nodejs", syncedAt: now },
            },
          },
          { upsert: true, new: true },
        );

        fileEntry.status = "completed";
        await job.save();
        emitToAccount(accountId, "job:file:completed", {
          jobId,
          fileIndex,
          filename: fileEntry.filename,
          qualifiedCount: fileEntry.qualifiedCount,
        });
      } catch (fileErr) {
        // File-level failure: mark file failed, continue with other files
        console.error(
          `[jobWorker] File ${fileEntry.filename} failed:`,
          fileErr,
        );
        fileEntry.status = "failed";
        fileEntry.error = fileErr.message;
        await job.save();
        emitToAccount(accountId, "job:file:failed", {
          jobId,
          fileIndex,
          filename: fileEntry.filename,
          error: fileErr.message,
        });
      }
    }

    // All files processed
    job.status = "completed";
    job.completedAt = new Date();
    await job.save();
    emitToAccount(accountId, "job:completed", {
      jobId,
      totalQualified: job.qualifiedLeads,
      totalFailed: job.failedLeads,
    });
  } catch (criticalErr) {
    // Critical failure: mark entire job failed
    console.error(`[jobWorker] Critical error on job ${jobId}:`, criticalErr);
    job.status = "failed";
    job.error = criticalErr.message;
    job.completedAt = new Date();
    await job.save();
    emitToAccount(accountId, "job:failed", {
      jobId,
      error: criticalErr.message,
    });
  } finally {
    clearBuffers(jobId);
  }
}

module.exports = { init, processJob };

const DeepScrapeJob = require("../models/DeepScrapeJob");
const deepScraper = require("./deepScraper");

let tickInterval = null;

async function processTick() {
  try {
    const dueJobs = await DeepScrapeJob.find({
      is_recurring: true,
      status: "completed",
      next_run_at: { $lte: new Date() },
    }).lean();

    for (const job of dueJobs) {
      console.log(
        `[deep-scrape-scheduler] Creating recurring job for seeds: ${job.seed_usernames.join(", ")}`,
      );

      const newJob = await DeepScrapeJob.create({
        account_id: job.account_id,
        name: job.name || null,
        seed_usernames: job.seed_usernames,
        reel_limit: job.reel_limit,
        comment_limit: job.comment_limit,
        min_followers: job.min_followers,
        force_reprocess: false,
        promptId: job.promptId,
        promptLabel: job.promptLabel,
        is_recurring: true,
        repeat_interval_days: job.repeat_interval_days,
        parent_job_id: job._id,
        status: "pending",
      });

      // Clear old job so it doesn't trigger again
      await DeepScrapeJob.updateOne(
        { _id: job._id },
        { $set: { next_run_at: null, is_recurring: false } },
      );

      deepScraper.processJob(newJob._id.toString());
    }
  } catch (err) {
    console.error("[deep-scrape-scheduler] Tick failed:", err);
  }
}

function start() {
  tickInterval = setInterval(processTick, 60000); // check every 60 seconds
  console.log("[deep-scrape-scheduler] Started");
}

function stop() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

module.exports = { start, stop };

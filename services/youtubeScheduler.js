const cron = require("node-cron");
const logger = require("../utils/logger").child({ module: "youtube-scheduler" });
const scrapeService = require("./scrapeService");

let scheduledTask = null;

function start() {
  // Run daily at 03:00 UTC
  scheduledTask = cron.schedule("0 3 * * *", async () => {
    logger.info("Scheduled scrape pipeline starting");
    try {
      const results = await scrapeService.runForAllAccounts();
      logger.info("Scheduled scrape pipeline complete:", results.length, "account(s) processed");
    } catch (err) {
      logger.error("Scheduled scrape pipeline failed:", err);
    }
  });

  logger.info("Scheduler started — pipeline runs daily at 03:00 UTC");
}

function stop() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info("Scheduler stopped");
  }
}

module.exports = { start, stop };

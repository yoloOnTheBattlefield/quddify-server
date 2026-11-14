const cron = require("node-cron");
const logger = require("../utils/logger").child({ module: "contentInsightsScheduler" });
const Account = require("../models/Account");
const instagramInsights = require("./instagramInsights");

// Refresh Instagram post metrics (views, likes, comments, ...) once a day so the
// dashboard is current without anyone pressing Sync. Only accounts connected
// through our own Meta app have a page token; Zernio exposes no post metrics.
const SCHEDULE = "0 4 * * *";
const TIMEZONE = "Europe/Bucharest";
const DAYS = 90;

let scheduledTask = null;

async function syncAll() {
  let accounts = [];
  try {
    accounts = await Account.find({
      "ig_oauth.page_access_token": { $ne: null },
      "ig_oauth.ig_user_id": { $ne: null },
      deleted: { $ne: true },
    })
      .select("_id")
      .lean();
  } catch (err) {
    logger.error({ err }, "[content-insights] Could not list accounts");
    return { accounts: 0, synced: 0, failed: 0 };
  }

  let synced = 0;
  let failed = 0;
  for (const { _id } of accounts) {
    try {
      const result = await instagramInsights.syncAccountInsights(_id, { days: DAYS });
      synced++;
      logger.info(
        `[content-insights] Account ${_id}: ${result.synced} post(s), ${result.with_insights} with insights`,
      );
    } catch (err) {
      failed++;
      logger.error({ err: err.message, accountId: String(_id) }, "[content-insights] Sync failed");
    }
  }
  return { accounts: accounts.length, synced, failed };
}

function start() {
  if (scheduledTask) return;
  scheduledTask = cron.schedule(
    SCHEDULE,
    () => {
      syncAll().catch((err) => logger.error({ err }, "[content-insights] Run failed"));
    },
    { timezone: TIMEZONE },
  );
  logger.info(`[content-insights] Scheduled daily at 04:00 ${TIMEZONE}`);
}

function stop() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

module.exports = { start, stop, syncAll };

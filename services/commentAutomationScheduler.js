const logger = require("../utils/logger").child({ module: "commentAutomationScheduler" });
const commentAutomation = require("./commentAutomation");

let tickInterval = null;

async function processTick() {
  try {
    const processed = await commentAutomation.processDueEvents();
    if (processed > 0) {
      logger.info(`[comment-automation-scheduler] Processed ${processed} event(s)`);
    }
  } catch (err) {
    logger.error("[comment-automation-scheduler] Tick failed:", err);
  }
}

function start() {
  if (tickInterval) return;
  tickInterval = setInterval(processTick, 15000); // drain every 15 seconds
  logger.info("[comment-automation-scheduler] Started");
}

function stop() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

module.exports = { start, stop, processTick };

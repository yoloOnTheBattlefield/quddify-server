/**
 * Compute the daily DM cap for an OutboundAccount based on its status
 * and warmup schedule.
 *
 * @param {Object} outbound - OutboundAccount document (lean)
 * @returns {number} max DMs allowed today (0 = blocked)
 */
function computeDailyLimit(outbound) {
  if (!outbound) return 50;

  const { status } = outbound;

  if (status === "new" || status === "restricted" || status === "disabled") {
    return 0;
  }

  if (status === "warming") {
    const warmup = outbound.warmup;
    if (warmup?.enabled && warmup?.startDate) {
      const msPerDay = 86_400_000;
      const warmupDay =
        Math.floor(
          (Date.now() - new Date(warmup.startDate).getTime()) / msPerDay,
        ) + 1;
      const entry = (warmup.schedule || []).find((s) => s.day === warmupDay);
      return entry ? entry.cap : 0;
    }
    return 0;
  }

  if (status === "ready") {
    return 50;
  }

  return 0;
}

module.exports = { computeDailyLimit };

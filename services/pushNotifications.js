const webpush = require("web-push");
const logger = require("../utils/logger").child({ module: "pushNotifications" });

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:admin@quddify-app.app",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

/**
 * Send a browser push notification to all subscriptions for an account.
 * Silently removes expired/invalid subscriptions (410 Gone).
 */
async function sendPushToAccount(accountId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    logger.warn("[push] VAPID keys not configured — skipping browser push");
    return;
  }

  const PushSubscription = require("../models/PushSubscription");
  const subscriptions = await PushSubscription.find({ account_id: accountId }).lean();
  if (subscriptions.length === 0) return;

  const body = JSON.stringify(payload);
  const expiredEndpoints = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          expiredEndpoints.push(sub.endpoint);
        } else {
          logger.warn(`[push] Failed to send to endpoint: ${err.message}`);
        }
      }
    }),
  );

  if (expiredEndpoints.length > 0) {
    await PushSubscription.deleteMany({ endpoint: { $in: expiredEndpoints } });
    logger.info(`[push] Removed ${expiredEndpoints.length} expired subscription(s)`);
  }
}

module.exports = { sendPushToAccount };

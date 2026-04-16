const logger = require("../utils/logger").child({ module: "prospectCleanup" });
const ProspectProfile = require("../models/ProspectProfile");
const ClientImage = require("../models/ClientImage");
const { remove } = require("./storageService");

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Clean up expired prospect profiles and their associated images from R2 and MongoDB.
 * MongoDB TTL index handles doc deletion as a safety net, but this service
 * also deletes R2 objects which TTL cannot do.
 */
async function cleanupExpiredProfiles() {
  try {
    const expired = await ProspectProfile.find({
      expires_at: { $lt: new Date() },
    }).lean();

    if (expired.length === 0) return;

    logger.info(`Cleaning up ${expired.length} expired prospect profile(s)`);

    for (const profile of expired) {
      try {
        // Delete prospect images from R2 and DB
        const images = await ClientImage.find({
          prospect_profile_id: profile._id,
        }).lean();

        for (const img of images) {
          try {
            await remove(img.storage_key);
          } catch {
            // best-effort — file may already be gone
          }
        }

        await ClientImage.deleteMany({ prospect_profile_id: profile._id });
        await ProspectProfile.findByIdAndDelete(profile._id);

        logger.info(`Cleaned up prospect profile ${profile._id} (@${profile.ig_handle}): ${images.length} images deleted`);
      } catch (err) {
        logger.error(`Failed to clean up profile ${profile._id}:`, err);
      }
    }
  } catch (err) {
    logger.error("Prospect cleanup sweep failed:", err);
  }
}

let cleanupTimer = null;

function startCleanupScheduler() {
  if (cleanupTimer) return;
  logger.info("Starting prospect cleanup scheduler (1h interval)");
  cleanupTimer = setInterval(cleanupExpiredProfiles, CLEANUP_INTERVAL_MS);
  // Run once on start after a short delay
  setTimeout(cleanupExpiredProfiles, 10_000);
}

function stopCleanupScheduler() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

module.exports = { startCleanupScheduler, stopCleanupScheduler, cleanupExpiredProfiles };

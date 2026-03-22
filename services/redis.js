/**
 * Redis client singleton.
 *
 * When REDIS_URL is set, returns a connected ioredis client.
 * When not set, returns a no-op stub so callers don't need guards.
 *
 * Usage:
 *   const redis = require("./services/redis");
 *   await redis.get("key");            // returns null if no Redis
 *   await redis.setex("key", 60, val); // no-op if no Redis
 */
const logger = require("../utils/logger").child({ module: "redis" });

let client = null;

// No-op stub when Redis is not configured
const stub = {
  get: async () => null,
  set: async () => "OK",
  setex: async () => "OK",
  del: async () => 0,
  incr: async () => 0,
  expire: async () => 0,
  exists: async () => 0,
  ttl: async () => -2,
  quit: async () => {},
  isStub: true,
};

function getClient() {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    logger.info("REDIS_URL not set — using in-memory stub");
    client = stub;
    return client;
  }

  try {
    // Dynamic import so the app doesn't crash if ioredis isn't installed
    const Redis = require("ioredis");
    client = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) return null; // stop retrying
        return Math.min(times * 200, 2000);
      },
      tls: url.startsWith("rediss://") ? {} : undefined,
    });

    client.on("connect", () => logger.info("Redis connected"));
    client.on("error", (err) => logger.error("Redis error:", err));
    client.isStub = false;
  } catch (err) {
    logger.warn("ioredis not installed — falling back to stub:", err.message);
    client = stub;
  }

  return client;
}

module.exports = getClient();

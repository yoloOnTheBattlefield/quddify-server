const pino = require("pino");

const base = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

/**
 * Wrap a pino logger so it accepts console-style arguments:
 *   logger.info("something happened:", value)
 *   logger.error("failed:", err)
 *
 * In production the structured JSON still contains the full error/object.
 */
function wrapLogger(pinoLogger) {
  const wrapped = Object.create(pinoLogger);

  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
    const original = pinoLogger[level].bind(pinoLogger);
    wrapped[level] = function (...args) {
      if (args.length === 0) return original();
      // Single string — pass through
      if (args.length === 1 && typeof args[0] === "string") return original(args[0]);
      // First arg is an object/error — pino native style, pass through
      if (args.length >= 1 && typeof args[0] === "object" && args[0] !== null) {
        return original(...args);
      }
      // console-style: ("msg:", value1, value2, ...)
      if (typeof args[0] === "string" && args.length > 1) {
        const msg = args[0];
        const rest = args.slice(1);
        // If the extra arg is an Error, use pino's { err } convention
        if (rest.length === 1 && rest[0] instanceof Error) {
          return original({ err: rest[0] }, msg);
        }
        // If the extra arg is an object, merge it
        if (rest.length === 1 && typeof rest[0] === "object" && rest[0] !== null) {
          return original(rest[0], msg);
        }
        // Multiple extra args — join as string
        return original(msg + " " + rest.map(String).join(" "));
      }
      return original(...args);
    };
  }

  wrapped.child = function (bindings) {
    return wrapLogger(pinoLogger.child(bindings));
  };

  return wrapped;
}

module.exports = wrapLogger(base);

const logger = require("../utils/logger").child({ module: "http" });

/**
 * Lightweight pino-based request logger middleware.
 * Logs method, url, status code, and response time for every request.
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

    logger[level](
      {
        reqId: req.id,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration,
      },
      `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`,
    );
  });

  next();
}

module.exports = requestLogger;

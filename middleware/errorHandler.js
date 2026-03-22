const logger = require("../utils/logger").child({ module: "errorHandler" });

/**
 * Central error-handling middleware.
 * Mount AFTER all routes: app.use(errorHandler);
 *
 * Routes can simply throw or call next(error) instead of
 * repeating try/catch + res.status(500) in every handler.
 */
function errorHandler(err, req, res, _next) {
  // Already sent headers — delegate to Express default handler
  if (res.headersSent) {
    return _next(err);
  }

  const status = err.status || err.statusCode || 500;
  const message =
    status < 500 ? err.message : "Internal server error";

  logger.error(
    { err, reqId: req.id, method: req.method, url: req.originalUrl },
    err.message || "Unhandled error",
  );

  res.status(status).json({ error: message });
}

module.exports = errorHandler;

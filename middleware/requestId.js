const crypto = require("crypto");

function requestId(req, res, next) {
  const id = req.headers["x-request-id"] || crypto.randomUUID();
  req.id = id;
  res.setHeader("x-request-id", id);
  // Attach to pino child logger so all logs in this request share the ID
  req.log = req.log ? req.log.child({ reqId: id }) : undefined;
  next();
}

module.exports = requestId;

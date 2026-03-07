const rateLimit = require("express-rate-limit");

// Strict limiter for auth endpoints (login/register) — prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
});

// General API limiter for authenticated routes
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
});

// Webhook limiter — generous but protects against floods
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded" },
});

module.exports = { authLimiter, apiLimiter, webhookLimiter };

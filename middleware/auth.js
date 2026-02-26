const jwt = require("jsonwebtoken");
const Account = require("../models/Account");
const OutboundAccount = require("../models/OutboundAccount");
const AccountUser = require("../models/AccountUser");

const JWT_SECRET = process.env.JWT_SECRET || "quddify-jwt-secret-change-in-production";

function generateToken(user, account, accountUser) {
  return jwt.sign(
    {
      userId: user._id,
      accountId: account._id,
      ghl: account.ghl,
      role: accountUser.role,
      has_outbound: account.has_outbound && accountUser.has_outbound,
      has_research: account.has_research && accountUser.has_research,
    },
    JWT_SECRET,
    { expiresIn: "7d" },
  );
}

function generateSelectionToken(user) {
  return jwt.sign(
    { userId: user._id, purpose: "account_selection" },
    JWT_SECRET,
    { expiresIn: "5m" },
  );
}

async function auth(req, res, next) {
  // Public endpoints under authenticated prefixes — they handle their own auth
  if (req.method === "POST" && req.path === "/accounts/select-account") return next();

  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers["x-api-key"];

  // Support both "Authorization: Bearer <token>" and "x-api-key: <key>"
  let token = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (apiKeyHeader) {
    token = apiKeyHeader;
  }

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  try {
    // API key auth (Chrome extension) — keys start with "qd_"
    if (token.startsWith("qd_")) {
      const account = await Account.findOne({ api_key: token }).lean();
      if (!account) return res.status(401).json({ error: "Invalid API key" });
      if (account.disabled) return res.status(403).json({ error: "Account is disabled" });
      if (account.deleted) return res.status(403).json({ error: "Account has been deleted" });
      req.account = account;
      return next();
    }

    // Browser token auth (new extension) — tokens start with "oat_"
    if (token.startsWith("oat_")) {
      const outboundAccount = await OutboundAccount.findOne({ browser_token: token }).lean();
      if (!outboundAccount) return res.status(401).json({ error: "Invalid browser token" });
      const account = await Account.findById(outboundAccount.account_id).lean();
      if (!account) return res.status(401).json({ error: "Account not found" });
      if (account.disabled) return res.status(403).json({ error: "Account is disabled" });
      if (account.deleted) return res.status(403).json({ error: "Account has been deleted" });
      req.account = account;
      req.outboundAccount = outboundAccount;
      return next();
    }

    // JWT auth (frontend dashboard)
    const decoded = jwt.verify(token, JWT_SECRET);
    const account = await Account.findById(decoded.accountId).lean();
    if (!account) return res.status(401).json({ error: "Account not found" });
    if (account.disabled && decoded.role !== 0) {
      return res.status(403).json({ error: "Account is disabled" });
    }
    if (account.deleted && decoded.role !== 0) {
      return res.status(403).json({ error: "Account has been deleted" });
    }

    // Verify user still has membership in this account
    const membership = await AccountUser.findOne({
      user_id: decoded.userId,
      account_id: decoded.accountId,
    }).lean();
    if (!membership) {
      return res.status(403).json({ error: "No longer a member of this account" });
    }

    req.account = account;
    req.user = decoded;
    req.membership = membership;
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    console.error("Auth error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
}

module.exports = { auth, generateToken, generateSelectionToken, JWT_SECRET };

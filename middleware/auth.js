const jwt = require("jsonwebtoken");
const Account = require("../models/Account");

const JWT_SECRET = process.env.JWT_SECRET || "quddify-jwt-secret-change-in-production";

function generateToken(user, account) {
  return jwt.sign(
    {
      userId: user._id,
      accountId: account._id,
      ghl: account.ghl,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: "7d" },
  );
}

async function auth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.slice(7);
  if (!token) {
    return res.status(401).json({ error: "Token is required" });
  }

  try {
    // API key auth (Chrome extension) — keys start with "qd_"
    if (token.startsWith("qd_")) {
      const account = await Account.findOne({ api_key: token }).lean();
      if (!account) return res.status(401).json({ error: "Invalid API key" });
      if (account.disabled) return res.status(403).json({ error: "Account is disabled" });
      req.account = account;
      return next();
    }

    // JWT auth (frontend dashboard)
    const decoded = jwt.verify(token, JWT_SECRET);
    const account = await Account.findById(decoded.accountId).lean();
    if (!account) return res.status(401).json({ error: "Account not found" });
    if (account.disabled && decoded.role !== 0) {
      return res.status(403).json({ error: "Account is disabled" });
    }
    req.account = account;
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    console.error("Auth error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
}

module.exports = { auth, generateToken };

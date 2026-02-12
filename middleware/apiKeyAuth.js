const Account = require("../models/Account");

async function apiKeyAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const apiKey = authHeader.slice(7);

  if (!apiKey) {
    return res.status(401).json({ error: "API key is required" });
  }

  try {
    const account = await Account.findOne({ api_key: apiKey }).lean();

    if (!account) {
      return res.status(401).json({ error: "Invalid API key" });
    }

    if (account.disabled) {
      return res.status(403).json({ error: "Account is disabled" });
    }

    req.account = account;
    next();
  } catch (err) {
    console.error("API key auth error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
}

module.exports = apiKeyAuth;

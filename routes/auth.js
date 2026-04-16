const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Account = require("../models/Account");
const AccountUser = require("../models/AccountUser");
const Client = require("../models/Client");
const { auth, generateToken, JWT_SECRET } = require("../middleware/auth");
const logger = require("../utils/logger").child({ module: "auth" });

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    // Find account membership
    const accountUser = await AccountUser.findOne({ user_id: user._id });
    if (!accountUser) return res.status(401).json({ error: "No account found" });

    const account = await Account.findById(accountUser.account_id);
    if (!account) return res.status(401).json({ error: "Account not found" });

    const token = generateToken(user, account, accountUser);

    // A user is considered a "client user" (managed by someone else) if any
    // Client doc has `user_id === user._id`. These users are technically
    // role=1 owners of their own isolated account, so we cannot rely on role.
    // Admins (role 0) are never treated as client users even if they have a
    // Client doc linked to them (e.g. they created a client for themselves).
    const isClientUser =
      accountUser.role !== 0 && !!(await Client.exists({ user_id: user._id }));

    res.json({
      token,
      account_id: account._id,
      user_id: user._id,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      role: accountUser.role,
      is_client_user: isClientUser,
    });
  } catch (err) {
    logger.error("Login failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// GET /api/auth/me — refresh the caller's user info from an existing token.
// Used by the frontend to re-derive `is_client_user` without forcing a
// re-login when that signal was added after the user last logged in.
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).lean();
    if (!user) return res.status(404).json({ error: "User not found" });

    const isClientUser =
      req.user.role !== 0 && !!(await Client.exists({ user_id: user._id }));

    res.json({
      user_id: user._id,
      account_id: req.user.accountId,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      role: req.user.role,
      is_client_user: isClientUser,
    });
  } catch (err) {
    logger.error("auth/me failed:", err);
    res.status(500).json({ error: "Failed to load user" });
  }
});

module.exports = router;

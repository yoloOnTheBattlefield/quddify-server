const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Account = require("../models/Account");
const AccountUser = require("../models/AccountUser");
const { generateToken, JWT_SECRET } = require("../middleware/auth");
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

    res.json({
      token,
      account_id: account._id,
      user_id: user._id,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      role: accountUser.role,
    });
  } catch (err) {
    logger.error("Login failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

module.exports = router;

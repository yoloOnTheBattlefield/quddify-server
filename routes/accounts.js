const express = require("express");
const bcrypt = require("bcrypt");
const Account = require("../models/Account");

const router = express.Router();

// get all accounts
router.get("/", async (req, res) => {
  const accounts = await Account.find().lean();
  res.json(accounts);
});

// register
router.post("/register", async (req, res) => {
  const { email, password, first_name, last_name, ghl } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  const exists = await Account.findOne({ email });
  if (exists) {
    return res.status(400).json({ error: "Account already exists" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  await Account.create({
    email,
    password: hashedPassword,
    first_name: first_name || null,
    last_name: last_name || null,
    ghl: ghl || null,
  });

  res.json({ success: true });
});

// login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const account = await Account.findOne({ email });
  if (!account) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const ok = await bcrypt.compare(password, account.password);
  if (!ok) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.json(account);
});

module.exports = router;

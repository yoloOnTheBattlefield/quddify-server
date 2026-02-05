const express = require("express");
const bcrypt = require("bcrypt");
const Account = require("../models/Account");
const Lead = require("../models/Lead");

const router = express.Router();

// get all accounts
router.get("/", async (req, res) => {
  const accounts = await Account.find().lean();
  res.json(accounts);
});

// GET /accounts/analytics - per-account lead stats
router.get("/analytics", async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    const accounts = await Account.find().lean();

    // Build date filter for leads
    const dateFilter = {};
    if (start_date || end_date) {
      dateFilter.date_created = {};
      if (start_date) dateFilter.date_created.$gte = `${start_date}T00:00:00.000Z`;
      if (end_date) dateFilter.date_created.$lte = `${end_date}T23:59:59.999Z`;
    }

    const results = await Promise.all(
      accounts.map(async (account) => {
        const filter = { account_id: account.ghl, ...dateFilter };
        const leads = await Lead.find(filter).lean();

        return {
          account_id: account._id,
          ghl: account.ghl,
          name: `${account.first_name || ""} ${account.last_name || ""}`.trim() || account.email,
          totalLeads: leads.length,
          qualified: leads.filter((l) => l.qualified_at).length,
          link_sent: leads.filter((l) => l.link_sent_at).length,
          booked: leads.filter((l) => l.booked_at).length,
          ghosted: leads.filter((l) => l.ghosted_at && !l.booked_at).length,
          follow_up: leads.filter((l) => l.follow_up_at).length,
          low_ticket: leads.filter((l) => l.low_ticket).length,
        };
      }),
    );

    res.json(results);
  } catch (error) {
    console.error("Account analytics error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
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

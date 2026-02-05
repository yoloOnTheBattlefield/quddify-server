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
      if (start_date)
        dateFilter.date_created.$gte = `${start_date}T00:00:00.000Z`;
      if (end_date) dateFilter.date_created.$lte = `${end_date}T23:59:59.999Z`;
    }

    const results = await Promise.all(
      accounts.map(async (account) => {
        const filter = { account_id: account.ghl, ...dateFilter };
        const leads = await Lead.find(filter).lean();

        return {
          account_id: account._id,
          ghl: account.ghl,
          name:
            `${account.first_name || ""} ${account.last_name || ""}`.trim() ||
            account.email,
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

// GET /accounts/ghl-webhook?_id=<client_id> - Get account info with webhook
router.get("/ghl-webhook", async (req, res) => {
  try {
    const { _id } = req.query;

    if (!_id) {
      return res.status(400).json({ message: "Missing _id" });
    }

    const account = await Account.findById(_id).lean();

    if (!account) {
      return res.status(404).json({ message: "Account not found" });
    }

    res.json({
      account_id: account._id,
      ghl: account.ghl,
      name:
        `${account.first_name || ""} ${account.last_name || ""}`.trim() ||
        account.email,
      ghl_lead_booked_webhook: account.ghl_lead_booked_webhook || undefined,
    });
  } catch (error) {
    console.error("GHL webhook fetch error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// POST /accounts/ghl-webhook - Set GHL webhook for an account
router.post("/ghl-webhook", async (req, res) => {
  try {
    const { ghl_lead_booked_webhook, _id } = req.body;

    if (!ghl_lead_booked_webhook) {
      return res.status(400).json({ message: "Missing ghl_lead_booked_webhook" });
    }

    if (!ghl_lead_booked_webhook.startsWith("http")) {
      return res.status(400).json({ message: "Invalid URL, must start with http" });
    }

    const account = await Account.findByIdAndUpdate(
      _id,
      { ghl_lead_booked_webhook },
      { new: true },
    );

    if (!account) {
      return res.status(404).json({ message: "Account not found" });
    }

    res.json({ message: "Webhook saved successfully" });
  } catch (error) {
    console.error("GHL webhook update error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;

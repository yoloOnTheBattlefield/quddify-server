const express = require("express");
const bcrypt = require("bcrypt");
const Account = require("../models/Account");
const User = require("../models/User");
const Lead = require("../models/Lead");

const router = express.Router();

// get all accounts
router.get("/", async (req, res) => {
  const [accounts, owners] = await Promise.all([
    Account.find().lean(),
    User.find({ role: { $lte: 1 } }, { password: 0 }).lean(),
  ]);

  const ownerMap = {};
  owners.forEach((owner) => {
    ownerMap[owner.account_id.toString()] = owner;
  });

  const result = accounts.map((account) => {
    const owner = ownerMap[account._id.toString()];
    return {
      ...account,
      name: owner
        ? `${owner.first_name || ""} ${owner.last_name || ""}`.trim() || owner.email
        : "Unknown",
      email: owner?.email || null,
    };
  });

  res.json(result);
});

// GET /accounts/analytics - per-account lead stats
router.get("/analytics", async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    const [accounts, owners] = await Promise.all([
      Account.find().lean(),
      User.find({ role: { $lte: 1 } }, { password: 0 }).lean(),
    ]);

    const ownerMap = {};
    owners.forEach((owner) => {
      ownerMap[owner.account_id.toString()] = owner;
    });

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
        const owner = ownerMap[account._id.toString()];

        return {
          account_id: account._id,
          ghl: account.ghl,
          name: owner
            ? `${owner.first_name || ""} ${owner.last_name || ""}`.trim() || owner.email
            : "Unknown",
          totalLeads: leads.length,
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

  const exists = await User.findOne({ email });
  if (exists) {
    return res.status(400).json({ error: "Account already exists" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const account = await Account.create({
    ghl: ghl || null,
  });

  try {
    await User.create({
      account_id: account._id,
      email,
      password: hashedPassword,
      first_name: first_name || null,
      last_name: last_name || null,
      role: 1,
    });
  } catch (error) {
    await Account.findByIdAndDelete(account._id);
    throw error;
  }

  res.json({ success: true });
});

// login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const account = await Account.findById(user.account_id).lean();

  if (account.disabled && user.role !== 0) {
    return res.status(403).json({ error: "Account is disabled" });
  }

  res.json({
    _id: user._id,
    account_id: account._id,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    role: user.role,
    ghl: account.ghl,
    calendly: account.calendly,
    ghl_lead_booked_webhook: account.ghl_lead_booked_webhook,
  });
});

// POST /accounts/team - Add team member to an account
router.post("/team", async (req, res) => {
  try {
    const { account_id, parent_id, email, password, first_name, last_name, role } = req.body;
    const accountRef = account_id || parent_id;

    if (!accountRef || !email || !password) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const account = await Account.findById(accountRef);
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(400).json({ error: "Email already in use" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const member = await User.create({
      account_id: accountRef,
      email,
      password: hashedPassword,
      first_name: first_name || null,
      last_name: last_name || null,
      role: role || 2,
    });

    res.status(201).json({
      _id: member._id,
      account_id: member.account_id,
      email: member.email,
      first_name: member.first_name,
      last_name: member.last_name,
      role: member.role,
    });
  } catch (error) {
    console.error("Add team member error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /accounts/team?account_id=<id> - Get all team members for an account
router.get("/team", async (req, res) => {
  try {
    const accountRef = req.query.account_id || req.query.parent_id;

    if (!accountRef) {
      return res.status(400).json({ error: "Missing account_id" });
    }

    const members = await User.find(
      { account_id: accountRef, role: { $ne: 1 } },
      { password: 0 },
    ).lean();

    res.json(members);
  } catch (error) {
    console.error("Get team members error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /accounts/team/:id - Remove a team member
router.delete("/team/:id", async (req, res) => {
  try {
    const member = await User.findById(req.params.id);

    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    if (member.role === 1) {
      return res.status(400).json({ error: "Cannot delete account owner" });
    }

    await User.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (error) {
    console.error("Delete team member error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /accounts/:id - Update user profile and account info
router.patch("/:id", async (req, res) => {
  try {
    const { first_name, last_name, email, ghl, calendly } = req.body;

    const userUpdates = {};
    if (first_name !== undefined) userUpdates.first_name = first_name;
    if (last_name !== undefined) userUpdates.last_name = last_name;
    if (email !== undefined) userUpdates.email = email;

    const accountUpdates = {};
    if (ghl !== undefined) accountUpdates.ghl = ghl;
    if (calendly !== undefined) accountUpdates.calendly = calendly;

    if (Object.keys(userUpdates).length === 0 && Object.keys(accountUpdates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // If email is being changed, check it's not already taken
    if (userUpdates.email) {
      const exists = await User.findOne({ email: userUpdates.email, _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ error: "Email already in use" });
      }
    }

    if (Object.keys(userUpdates).length > 0) {
      await User.findByIdAndUpdate(req.params.id, userUpdates);
    }

    if (Object.keys(accountUpdates).length > 0) {
      await Account.findByIdAndUpdate(user.account_id, accountUpdates);
    }

    const updatedUser = await User.findById(req.params.id, { password: 0 }).lean();
    const updatedAccount = await Account.findById(user.account_id).lean();

    res.json({
      _id: updatedUser._id,
      account_id: updatedAccount._id,
      first_name: updatedUser.first_name,
      last_name: updatedUser.last_name,
      email: updatedUser.email,
      role: updatedUser.role,
      ghl: updatedAccount.ghl,
      calendly: updatedAccount.calendly,
      ghl_lead_booked_webhook: updatedAccount.ghl_lead_booked_webhook,
    });
  } catch (error) {
    console.error("Account update error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /accounts/:id/password - Change password
router.post("/:id/password", async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: "Missing current_password or new_password" });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const ok = await bcrypt.compare(current_password, user.password);
    if (!ok) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    user.password = await bcrypt.hash(new_password, 10);
    await user.save();

    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Password update error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /accounts/ghl-webhook?_id=<account_id> - Get account info with webhook
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

    const owner = await User.findOne({ account_id: account._id, role: { $lte: 1 } }, { password: 0 }).lean();

    res.json({
      account_id: account._id,
      ghl: account.ghl,
      name: owner
        ? `${owner.first_name || ""} ${owner.last_name || ""}`.trim() || owner.email
        : "Unknown",
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

// PATCH /accounts/:id/disable - Toggle disabled status on an account
router.patch("/:id/disable", async (req, res) => {
  try {
    const account = await Account.findById(req.params.id);
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    account.disabled = !account.disabled;
    await account.save();

    res.json({ account_id: account._id, disabled: account.disabled });
  } catch (error) {
    console.error("Toggle disable error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

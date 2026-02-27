const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Account = require("../models/Account");
const User = require("../models/User");
const AccountUser = require("../models/AccountUser");
const Lead = require("../models/Lead");
const { generateToken, generateSelectionToken, JWT_SECRET } = require("../middleware/auth");

const router = express.Router();

// ---------- helpers ----------

function buildLoginResponse(user, account, accountUser) {
  const token = generateToken(user, account, accountUser);
  return {
    token,
    _id: user._id,
    account_id: account._id,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    role: accountUser.role,
    has_outbound: account.has_outbound && accountUser.has_outbound,
    has_research: account.has_research && accountUser.has_research,
    ghl: account.ghl,
    calendly: account.calendly,
    ghl_lead_booked_webhook: account.ghl_lead_booked_webhook,
    openai_token: account.openai_token,
    api_key: account.api_key,
    ig_session_set: !!(account.ig_session?.session_id) || (account.ig_sessions && account.ig_sessions.length > 0),
    ig_username: account.ig_session?.ig_username || null,
    ig_sessions: (account.ig_sessions || []).map((s) => ({
      ig_username: s.ig_username,
      has_cookies: !!(s.session_id && s.csrf_token && s.ds_user_id),
    })),
  };
}

function accountName(account) {
  return account.name || "Unnamed Account";
}

// ---------- get all accounts (admin) ----------

router.get("/", async (req, res) => {
  const accounts = await Account.find({ deleted: { $ne: true } }).lean();

  const result = accounts.map((account) => ({
    ...account,
    name: accountName(account),
  }));

  res.json(result);
});

// ---------- GET /accounts/me ----------

router.get("/me", async (req, res) => {
  try {
    const account = req.account;
    res.json({
      openai_token: account.openai_token || null,
      claude_token: account.claude_token || null,
      calendly_token: account.calendly_token || null,
    });
  } catch (error) {
    console.error("Get account me error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- GET /accounts/analytics ----------

router.get("/analytics", async (req, res) => {
  try {
    const { start_date, end_date, show_deleted } = req.query;
    const accountFilter = show_deleted === "true" ? {} : { deleted: { $ne: true } };
    const accounts = await Account.find(accountFilter).lean();

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
          name: accountName(account),
          deleted: !!account.deleted,
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

// ---------- register ----------

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
  const displayName = `${first_name || ""} ${last_name || ""}`.trim() || email;

  const account = await Account.create({
    name: displayName,
    ghl: ghl || null,
  });

  let user;
  try {
    user = await User.create({
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

  await AccountUser.create({
    user_id: user._id,
    account_id: account._id,
    role: 1,
    has_outbound: false,
    has_research: true,
    is_default: true,
  });

  res.json({ success: true });
});

// ---------- login (multi-account aware) ----------

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Fetch all account memberships
    const memberships = await AccountUser.find({ user_id: user._id }).lean();

    if (memberships.length === 0) {
      return res.status(403).json({ error: "No account access. Contact your admin." });
    }

    // Single account → auto-select
    if (memberships.length === 1) {
      const m = memberships[0];
      const account = await Account.findById(m.account_id).lean();
      if (!account) return res.status(404).json({ error: "Account not found" });
      if (account.disabled && m.role !== 0) {
        return res.status(403).json({ error: "Account is disabled" });
      }
      return res.json({
        ...buildLoginResponse(user, account, m),
        accounts: [{ account_id: m.account_id, name: accountName(account), ghl: account.ghl, role: m.role, has_outbound: (account.has_outbound ?? false) && m.has_outbound, has_research: (account.has_research ?? false) && m.has_research, is_default: m.is_default }],
      });
    }

    // Multiple accounts → return selection list
    const accountIds = memberships.map((m) => m.account_id);
    const accounts = await Account.find({ _id: { $in: accountIds }, deleted: { $ne: true } }).lean();
    const accountMap = {};
    accounts.forEach((a) => { accountMap[a._id.toString()] = a; });

    const selectionToken = generateSelectionToken(user);

    res.json({
      needs_account_selection: true,
      selection_token: selectionToken,
      user: {
        _id: user._id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
      },
      accounts: memberships.map((m) => {
        const acc = accountMap[m.account_id.toString()];
        return {
          account_id: m.account_id,
          name: acc ? accountName(acc) : "Unknown",
          ghl: acc?.ghl || null,
          role: m.role,
          has_outbound: (acc?.has_outbound ?? false) && m.has_outbound,
          has_research: (acc?.has_research ?? false) && m.has_research,
          is_default: m.is_default,
          disabled: acc?.disabled || false,
        };
      }),
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- POST /accounts/select-account (PUBLIC — no auth middleware) ----------

router.post("/select-account", async (req, res) => {
  try {
    const { selection_token, account_id } = req.body;

    if (!selection_token || !account_id) {
      return res.status(400).json({ error: "selection_token and account_id are required" });
    }

    let decoded;
    try {
      decoded = jwt.verify(selection_token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired selection token" });
    }

    if (decoded.purpose !== "account_selection") {
      return res.status(401).json({ error: "Invalid token purpose" });
    }

    const user = await User.findById(decoded.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const accountUser = await AccountUser.findOne({
      user_id: decoded.userId,
      account_id,
    }).lean();
    if (!accountUser) {
      return res.status(403).json({ error: "Not a member of this account" });
    }

    const account = await Account.findById(account_id).lean();
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (account.disabled && accountUser.role !== 0) {
      return res.status(403).json({ error: "Account is disabled" });
    }

    // Include all accounts for the switcher
    const allMemberships = await AccountUser.find({ user_id: decoded.userId }).lean();
    const allAccountIds = allMemberships.map((m) => m.account_id);
    const allAccounts = await Account.find({ _id: { $in: allAccountIds }, deleted: { $ne: true } }).lean();
    const accMap = {};
    allAccounts.forEach((a) => { accMap[a._id.toString()] = a; });

    res.json({
      ...buildLoginResponse(user, account, accountUser),
      accounts: allMemberships.map((m) => {
        const acc = accMap[m.account_id.toString()];
        return { account_id: m.account_id, name: acc ? accountName(acc) : "Unknown", ghl: acc?.ghl || null, role: m.role, has_outbound: (acc?.has_outbound ?? false) && m.has_outbound, has_research: (acc?.has_research ?? false) && m.has_research, is_default: m.is_default };
      }),
    });
  } catch (error) {
    console.error("Select account error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- POST /accounts/switch-account (PROTECTED) ----------

router.post("/switch-account", async (req, res) => {
  try {
    const { account_id } = req.body;
    if (!account_id) return res.status(400).json({ error: "account_id is required" });

    const accountUser = await AccountUser.findOne({
      user_id: req.user.userId,
      account_id,
    }).lean();
    if (!accountUser) {
      return res.status(403).json({ error: "Not a member of this account" });
    }

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const account = await Account.findById(account_id).lean();
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (account.disabled && accountUser.role !== 0) {
      return res.status(403).json({ error: "Account is disabled" });
    }

    // Include all accounts for the switcher
    const allMemberships = await AccountUser.find({ user_id: req.user.userId }).lean();
    const allAccountIds = allMemberships.map((m) => m.account_id);
    const allAccounts = await Account.find({ _id: { $in: allAccountIds }, deleted: { $ne: true } }).lean();
    const accMap = {};
    allAccounts.forEach((a) => { accMap[a._id.toString()] = a; });

    res.json({
      ...buildLoginResponse(user, account, accountUser),
      accounts: allMemberships.map((m) => {
        const acc = accMap[m.account_id.toString()];
        return { account_id: m.account_id, name: acc ? accountName(acc) : "Unknown", ghl: acc?.ghl || null, role: m.role, has_outbound: (acc?.has_outbound ?? false) && m.has_outbound, has_research: (acc?.has_research ?? false) && m.has_research, is_default: m.is_default };
      }),
    });
  } catch (error) {
    console.error("Switch account error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- GET /accounts/my-accounts (PROTECTED) ----------

router.get("/my-accounts", async (req, res) => {
  try {
    const memberships = await AccountUser.find({ user_id: req.user.userId }).lean();
    const accountIds = memberships.map((m) => m.account_id);
    const accounts = await Account.find({ _id: { $in: accountIds }, deleted: { $ne: true } }).lean();
    const accountMap = {};
    accounts.forEach((a) => { accountMap[a._id.toString()] = a; });

    res.json({
      accounts: memberships.map((m) => {
        const acc = accountMap[m.account_id.toString()];
        return {
          account_id: m.account_id,
          name: acc ? accountName(acc) : "Unknown",
          ghl: acc?.ghl || null,
          role: m.role,
          has_outbound: (acc?.has_outbound ?? false) && m.has_outbound,
          has_research: (acc?.has_research ?? false) && m.has_research,
          is_default: m.is_default,
        };
      }),
    });
  } catch (error) {
    console.error("My accounts error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- POST /accounts/team ----------

router.post("/team", async (req, res) => {
  try {
    const { email, password, first_name, last_name, role, has_outbound, account_id } = req.body;
    const accountRef = (account_id && req.user?.role === 0) ? account_id : req.account._id;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const account = await Account.findById(accountRef);
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    let user = await User.findOne({ email });

    if (user) {
      // Existing user — just link to this account
      const existingMembership = await AccountUser.findOne({
        user_id: user._id,
        account_id: accountRef,
      });
      if (existingMembership) {
        return res.status(400).json({ error: "User is already a member of this account" });
      }
    } else {
      // New user — must have password
      if (!password) {
        return res.status(400).json({ error: "Password is required for new users" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      user = await User.create({
        account_id: accountRef,
        email,
        password: hashedPassword,
        first_name: first_name || null,
        last_name: last_name || null,
        role: role || 2,
        has_outbound: has_outbound || false,
      });
    }

    const membership = await AccountUser.create({
      user_id: user._id,
      account_id: accountRef,
      role: role || 2,
      has_outbound: has_outbound || false,
      has_research: true,
      is_default: false,
    });

    res.status(201).json({
      _id: membership._id,
      user_id: user._id,
      account_id: accountRef,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: membership.role,
      has_outbound: membership.has_outbound,
    });
  } catch (error) {
    console.error("Add team member error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- GET /accounts/team/check-email ----------

router.get("/team/check-email", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const user = await User.findOne({ email }).lean();
    if (!user) return res.json({ exists: false });

    res.json({
      exists: true,
      first_name: user.first_name,
      last_name: user.last_name,
    });
  } catch (error) {
    console.error("Check email error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- GET /accounts/team ----------

router.get("/team", async (req, res) => {
  try {
    let accountId = req.account._id;

    if (req.query.account_id && req.user?.role === 0) {
      accountId = req.query.account_id;
    }

    const memberships = await AccountUser.find({ account_id: accountId })
      .populate("user_id", "-password")
      .lean();

    // Filter out owner (role 1) for non-admin callers, same as before
    const members = memberships
      .filter((m) => m.role !== 1)
      .map((m) => ({
        _id: m._id,
        user_id: m.user_id?._id,
        account_id: m.account_id,
        email: m.user_id?.email,
        first_name: m.user_id?.first_name,
        last_name: m.user_id?.last_name,
        role: m.role,
        has_outbound: m.has_outbound,
        has_research: m.has_research,
      }));

    res.json(members);
  } catch (error) {
    console.error("Get team members error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- DELETE /accounts/team/:id ----------

router.delete("/team/:id", async (req, res) => {
  try {
    const membership = await AccountUser.findById(req.params.id);

    if (!membership) {
      return res.status(404).json({ error: "Member not found" });
    }

    if (membership.role === 1) {
      return res.status(400).json({ error: "Cannot remove account owner" });
    }

    if (req.user && membership.user_id.toString() === req.user.userId.toString()) {
      return res.status(400).json({ error: "Cannot remove yourself" });
    }

    await AccountUser.findByIdAndDelete(req.params.id);

    // If user has no remaining memberships, optionally clean up
    const remaining = await AccountUser.countDocuments({ user_id: membership.user_id });
    if (remaining === 0) {
      await User.findByIdAndDelete(membership.user_id);
    }

    res.json({ deleted: true });
  } catch (error) {
    console.error("Delete team member error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- IG Sessions (unchanged — account-scoped) ----------

router.get("/ig-sessions", async (req, res) => {
  try {
    const account = await Account.findById(req.account._id).lean();
    if (!account) return res.status(404).json({ error: "Account not found" });

    const sessions = (account.ig_sessions || []).map((s) => ({
      ig_username: s.ig_username,
      has_cookies: !!(s.session_id && s.csrf_token && s.ds_user_id),
      added_at: s.added_at,
    }));

    const legacy = account.ig_session;
    if (legacy && legacy.session_id && legacy.ig_username) {
      const alreadyInArray = sessions.some(
        (s) => s.ig_username === legacy.ig_username,
      );
      if (!alreadyInArray) {
        sessions.unshift({
          ig_username: legacy.ig_username,
          has_cookies: !!(legacy.session_id && legacy.csrf_token && legacy.ds_user_id),
          added_at: null,
        });
      }
    }

    res.json({ ig_sessions: sessions });
  } catch (error) {
    console.error("Get IG sessions error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/ig-sessions", async (req, res) => {
  try {
    const { ig_username, cookies } = req.body;

    if (!ig_username) {
      return res.status(400).json({ error: "ig_username is required" });
    }
    if (!cookies || !Array.isArray(cookies)) {
      return res.status(400).json({ error: "cookies must be a JSON array" });
    }

    const username = ig_username.replace(/^@/, "").trim();
    const find = (name) => {
      const c = cookies.find((c) => c.name === name);
      return c ? c.value : null;
    };
    const session_id = find("sessionid");
    const csrf_token = find("csrftoken");
    const ds_user_id = find("ds_user_id");

    if (!session_id) {
      return res.status(400).json({ error: "sessionid cookie not found in array" });
    }

    const account = await Account.findById(req.account._id);
    if (!account) return res.status(404).json({ error: "Account not found" });

    if (!account.ig_sessions) account.ig_sessions = [];

    const existingIdx = account.ig_sessions.findIndex(
      (s) => s.ig_username === username,
    );
    const entry = { ig_username: username, session_id, csrf_token, ds_user_id, added_at: new Date() };

    if (existingIdx >= 0) {
      account.ig_sessions[existingIdx] = entry;
    } else {
      account.ig_sessions.push(entry);
    }

    await account.save();

    res.json({
      success: true,
      ig_session: { ig_username: username, has_cookies: true, added_at: entry.added_at },
    });
  } catch (error) {
    console.error("Add IG session error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/ig-sessions/:username", async (req, res) => {
  try {
    const username = req.params.username.replace(/^@/, "").trim();

    const account = await Account.findById(req.account._id);
    if (!account) return res.status(404).json({ error: "Account not found" });

    if (!account.ig_sessions || account.ig_sessions.length === 0) {
      return res.status(404).json({ error: "No IG sessions found" });
    }

    const before = account.ig_sessions.length;
    account.ig_sessions = account.ig_sessions.filter(
      (s) => s.ig_username !== username,
    );

    if (account.ig_sessions.length === before) {
      return res.status(404).json({ error: "Session not found for this username" });
    }

    account.markModified("ig_sessions");

    if (account.ig_session && account.ig_session.ig_username === username) {
      account.ig_session = { ig_username: null, session_id: null, csrf_token: null, ds_user_id: null };
      account.markModified("ig_session");
    }

    await account.save();
    res.json({ success: true });
  } catch (error) {
    console.error("Delete IG session error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- PATCH /accounts/:id ----------

router.patch("/:id", async (req, res) => {
  try {
    const { first_name, last_name, email, has_outbound, has_research, ghl, calendly, openai_token, claude_token, apify_token, ig_session, ig_username, ig_proxy } = req.body;

    const userUpdates = {};
    if (first_name !== undefined) userUpdates.first_name = first_name;
    if (last_name !== undefined) userUpdates.last_name = last_name;
    if (email !== undefined) userUpdates.email = email;

    const accountUpdates = {};
    if (ghl !== undefined) accountUpdates.ghl = ghl;
    if (calendly !== undefined) accountUpdates.calendly = calendly;
    if (openai_token !== undefined) accountUpdates.openai_token = openai_token;
    if (claude_token !== undefined) accountUpdates.claude_token = claude_token;
    if (apify_token !== undefined) accountUpdates.apify_token = apify_token;
    if (ig_proxy !== undefined) accountUpdates.ig_proxy = ig_proxy || null;
    if (ig_session !== undefined) {
      if (Array.isArray(ig_session)) {
        const find = (name) => {
          const c = ig_session.find((c) => c.name === name);
          return c ? c.value : null;
        };
        accountUpdates.ig_session = {
          ig_username: ig_username || null,
          session_id: find("sessionid"),
          csrf_token: find("csrftoken"),
          ds_user_id: find("ds_user_id"),
        };
      } else {
        if (ig_username !== undefined) ig_session.ig_username = ig_username;
        accountUpdates.ig_session = ig_session;
      }
    } else if (ig_username !== undefined) {
      accountUpdates["ig_session.ig_username"] = ig_username;
    }

    // Membership-level updates (go to AccountUser, not User)
    const membershipUpdates = {};
    if (has_outbound !== undefined) membershipUpdates.has_outbound = has_outbound;
    if (has_research !== undefined) membershipUpdates.has_research = has_research;

    if (Object.keys(userUpdates).length === 0 && Object.keys(accountUpdates).length === 0 && Object.keys(membershipUpdates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (userUpdates.email) {
      const exists = await User.findOne({ email: userUpdates.email, _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ error: "Email already in use" });
      }
    }

    // Resolve which account to update — use active account from JWT
    const activeAccountId = req.account._id;

    if (Object.keys(userUpdates).length > 0) {
      await User.findByIdAndUpdate(req.params.id, userUpdates);
    }

    if (Object.keys(accountUpdates).length > 0) {
      await Account.findByIdAndUpdate(activeAccountId, accountUpdates);
    }

    if (Object.keys(membershipUpdates).length > 0) {
      await AccountUser.findOneAndUpdate(
        { user_id: req.params.id, account_id: activeAccountId },
        membershipUpdates,
      );
    }

    const updatedUser = await User.findById(req.params.id, { password: 0 }).lean();
    const updatedAccount = await Account.findById(activeAccountId).lean();
    const updatedMembership = await AccountUser.findOne({
      user_id: req.params.id,
      account_id: activeAccountId,
    }).lean();

    res.json({
      _id: updatedUser._id,
      account_id: updatedAccount._id,
      first_name: updatedUser.first_name,
      last_name: updatedUser.last_name,
      email: updatedUser.email,
      role: updatedMembership?.role ?? updatedUser.role,
      has_outbound: updatedMembership?.has_outbound ?? updatedUser.has_outbound,
      has_research: updatedMembership?.has_research ?? true,
      ghl: updatedAccount.ghl,
      calendly: updatedAccount.calendly,
      ghl_lead_booked_webhook: updatedAccount.ghl_lead_booked_webhook,
      openai_token: updatedAccount.openai_token,
      claude_token: updatedAccount.claude_token,
      apify_token: updatedAccount.apify_token,
      api_key: updatedAccount.api_key,
      ig_session_set: !!(updatedAccount.ig_session?.session_id) || (updatedAccount.ig_sessions && updatedAccount.ig_sessions.length > 0),
      ig_username: updatedAccount.ig_session?.ig_username || null,
      ig_sessions: (updatedAccount.ig_sessions || []).map((s) => ({
        ig_username: s.ig_username,
        has_cookies: !!(s.session_id && s.csrf_token && s.ds_user_id),
      })),
    });
  } catch (error) {
    console.error("Account update error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- POST /accounts/:id/password ----------

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

// ---------- GHL webhook endpoints (public, unchanged) ----------

router.get("/ghl-webhook", async (req, res) => {
  try {
    const { _id } = req.query;
    if (!_id) return res.status(400).json({ message: "Missing _id" });

    const account = await Account.findById(_id).lean();
    if (!account) return res.status(404).json({ message: "Account not found" });

    res.json({
      account_id: account._id,
      ghl: account.ghl,
      name: accountName(account),
      has_outbound: !!account.has_outbound,
      has_research: !!account.has_research,
      ghl_lead_booked_webhook: account.ghl_lead_booked_webhook || undefined,
    });
  } catch (error) {
    console.error("GHL webhook fetch error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

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
    if (!account) return res.status(404).json({ message: "Account not found" });

    res.json({ message: "Webhook saved successfully" });
  } catch (error) {
    console.error("GHL webhook update error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ---------- PATCH /accounts/:accountId/has-outbound ----------

router.patch("/:accountId/has-outbound", async (req, res) => {
  try {
    if (req.user?.role !== 0) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { has_outbound } = req.body;
    const account = await Account.findByIdAndUpdate(
      req.params.accountId,
      { has_outbound: !!has_outbound },
      { new: true },
    );
    if (!account) return res.status(404).json({ error: "Account not found" });

    res.json({ has_outbound: account.has_outbound });
  } catch (error) {
    console.error("Toggle has_outbound error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- PATCH /accounts/:accountId/has-research ----------

router.patch("/:accountId/has-research", async (req, res) => {
  try {
    if (req.user?.role !== 0) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { has_research } = req.body;
    const account = await Account.findByIdAndUpdate(
      req.params.accountId,
      { has_research: !!has_research },
      { new: true },
    );
    if (!account) return res.status(404).json({ error: "Account not found" });

    res.json({ has_research: account.has_research });
  } catch (error) {
    console.error("Toggle has_research error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- PATCH /accounts/:id/disable ----------

router.patch("/:id/disable", async (req, res) => {
  try {
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ error: "Account not found" });

    account.disabled = !account.disabled;
    await account.save();

    res.json({ account_id: account._id, disabled: account.disabled });
  } catch (error) {
    console.error("Toggle disable error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- POST /accounts/:id/api-key ----------

router.post("/:id/api-key", async (req, res) => {
  try {
    // :id is the user id; resolve account from active JWT context
    const account = await Account.findById(req.account._id);
    if (!account) return res.status(404).json({ error: "Account not found" });

    const apiKey = `qd_${crypto.randomUUID().replace(/-/g, "")}`;
    account.api_key = apiKey;
    await account.save();

    res.json({ api_key: apiKey });
  } catch (error) {
    console.error("Generate API key error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- PATCH /accounts/:id/delete (soft delete) ----------

router.patch("/:id/delete", async (req, res) => {
  try {
    if (!req.user || req.user.role !== 0) {
      return res.status(403).json({ error: "Only super admins can delete accounts" });
    }

    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ error: "Account not found" });

    account.deleted = true;
    account.deleted_at = new Date();
    await account.save();

    res.json({ account_id: account._id, deleted: true });
  } catch (error) {
    console.error("Soft delete error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- PATCH /accounts/:id/restore ----------

router.patch("/:id/restore", async (req, res) => {
  try {
    if (!req.user || req.user.role !== 0) {
      return res.status(403).json({ error: "Only super admins can restore accounts" });
    }

    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ error: "Account not found" });

    account.deleted = false;
    account.deleted_at = null;
    await account.save();

    res.json({ account_id: account._id, deleted: false });
  } catch (error) {
    console.error("Restore account error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

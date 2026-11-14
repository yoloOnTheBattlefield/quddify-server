const logger = require("../utils/logger").child({ module: "comment-rules" });
const express = require("express");

const CommentRule = require("../models/CommentRule");
const CommentEvent = require("../models/CommentEvent");
const Account = require("../models/Account");
const Lead = require("../models/Lead");
const validate = require("../middleware/validate");
const {
  createRuleSchema,
  updateRuleSchema,
  idParamSchema,
  listEventsSchema,
  statsSchema,
} = require("../schemas/comment-rules");

const router = express.Router();

// Only these fields may come from the client — ig_user_id is verified separately.
const WRITABLE = [
  "name",
  "media_ids",
  "keywords",
  "match_mode",
  "dm_text",
  "link_url",
  "reply_publicly",
  "public_replies",
  "active",
];

function pickWritable(body) {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => WRITABLE.includes(key)),
  );
}

// Confirm the IG account is actually connected to the caller's account, so a
// rule can't be pointed at somebody else's Instagram. Either connection path
// counts: our own Meta app (ig_oauth) or Zernio.
async function ownsIgAccount(accountId, igUserId) {
  return !!(await Account.exists({
    _id: accountId,
    $or: [{ "ig_oauth.ig_user_id": igUserId }, { "zernio.ig_user_id": igUserId }],
  }));
}

// ─── GET /api/comment-rules/ig-accounts — connectable IG accounts ────────────
router.get("/ig-accounts", async (req, res) => {
  try {
    const account = await Account.findById(req.account._id)
      .select("ig_oauth.ig_user_id ig_oauth.ig_username zernio.ig_user_id zernio.ig_username")
      .lean();

    const accounts = [];
    if (account?.ig_oauth?.ig_user_id) {
      accounts.push({
        ig_user_id: account.ig_oauth.ig_user_id,
        ig_username: account.ig_oauth.ig_username,
        kind: "account",
      });
    }
    const z = account?.zernio;
    if (z?.ig_user_id && z.ig_user_id !== account?.ig_oauth?.ig_user_id) {
      accounts.push({ ig_user_id: z.ig_user_id, ig_username: z.ig_username, kind: "zernio" });
    }

    res.json({ accounts });
  } catch (err) {
    logger.error("[comment-rules] ig-accounts error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /api/comment-rules/stats — which lead magnet gets requested most ────
// A rule is a lead magnet (name + link_url). "requests" = comments that matched
// the rule inside the window; active rules with no requests are listed last.
router.get("/stats", validate(statsSchema), async (req, res) => {
  try {
    const days = Number(req.query.days) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const accountId = req.account._id;

    const [groups, rules] = await Promise.all([
      CommentEvent.aggregate([
        { $match: { account_id: accountId, rule_id: { $ne: null }, createdAt: { $gte: since } } },
        {
          $group: {
            _id: "$rule_id",
            requests: { $sum: 1 },
            sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
            lead_ids: { $addToSet: "$lead_id" },
          },
        },
      ]),
      CommentRule.find({ account_id: accountId })
        .select("name keywords link_url active")
        .lean(),
    ]);

    const leadIds = groups.flatMap((g) => g.lead_ids.filter(Boolean));
    const bookedIds = new Set(
      leadIds.length
        ? (await Lead.find({ _id: { $in: leadIds }, booked_at: { $ne: null } }).select("_id").lean())
            .map((l) => String(l._id))
        : [],
    );

    const ruleById = new Map(rules.map((r) => [String(r._id), r]));
    const rows = groups.map((g) => {
      const rule = ruleById.get(String(g._id));
      const leads = g.lead_ids.filter(Boolean).map(String);
      return {
        rule_id: g._id,
        name: rule?.name || "(deleted rule)",
        keywords: rule?.keywords || [],
        link_url: rule?.link_url || null,
        requests: g.requests,
        sent: g.sent,
        leads: leads.length,
        booked: leads.filter((id) => bookedIds.has(id)).length,
      };
    });
    rows.sort((a, b) => b.requests - a.requests || b.sent - a.sent);

    const seen = new Set(rows.map((r) => String(r.rule_id)));
    for (const r of rules) {
      if (!r.active || seen.has(String(r._id))) continue;
      rows.push({
        rule_id: r._id,
        name: r.name,
        keywords: r.keywords || [],
        link_url: r.link_url || null,
        requests: 0,
        sent: 0,
        leads: 0,
        booked: 0,
      });
    }

    res.json({ days, rules: rows });
  } catch (err) {
    logger.error("[comment-rules] stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /api/comment-rules/events — recent activity ────────────────────────
router.get("/events", validate(listEventsSchema), async (req, res) => {
  try {
    const filter = { account_id: req.account._id };
    if (req.query.rule_id) filter.rule_id = req.query.rule_id;
    if (req.query.status) filter.status = req.query.status;

    const events = await CommentEvent.find(filter)
      .sort({ createdAt: -1 })
      .limit(req.query.limit || 50)
      .lean();

    res.json({ events });
  } catch (err) {
    logger.error("[comment-rules] events error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /api/comment-rules ─────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const rules = await CommentRule.find({ account_id: req.account._id })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ rules });
  } catch (err) {
    logger.error("[comment-rules] list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/comment-rules ────────────────────────────────────────────────
router.post("/", validate(createRuleSchema), async (req, res) => {
  try {
    const { ig_user_id } = req.body;

    if (!(await ownsIgAccount(req.account._id, ig_user_id))) {
      return res.status(403).json({ error: "Instagram account not connected to this account" });
    }

    const rule = await CommentRule.create({
      ...pickWritable(req.body),
      ig_user_id,
      account_id: req.account._id,
    });

    logger.info(`[comment-rules] Created rule ${rule._id} for IG ${ig_user_id}`);
    res.status(201).json({ rule });
  } catch (err) {
    logger.error("[comment-rules] create error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PATCH /api/comment-rules/:id ───────────────────────────────────────────
router.patch("/:id", validate(updateRuleSchema), async (req, res) => {
  try {
    const updates = pickWritable(req.body);

    if (req.body.ig_user_id) {
      if (!(await ownsIgAccount(req.account._id, req.body.ig_user_id))) {
        return res.status(403).json({ error: "Instagram account not connected to this account" });
      }
      updates.ig_user_id = req.body.ig_user_id;
    }

    const rule = await CommentRule.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: updates },
      { new: true },
    );

    if (!rule) return res.status(404).json({ error: "Rule not found" });
    res.json({ rule });
  } catch (err) {
    logger.error("[comment-rules] update error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── DELETE /api/comment-rules/:id ──────────────────────────────────────────
router.delete("/:id", validate(idParamSchema), async (req, res) => {
  try {
    const rule = await CommentRule.findOneAndDelete({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!rule) return res.status(404).json({ error: "Rule not found" });
    res.json({ deleted: true });
  } catch (err) {
    logger.error("[comment-rules] delete error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

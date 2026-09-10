const logger = require("../utils/logger").child({ module: "comment-rules" });
const express = require("express");

const CommentRule = require("../models/CommentRule");
const CommentEvent = require("../models/CommentEvent");
const Account = require("../models/Account");
const OutboundAccount = require("../models/OutboundAccount");
const validate = require("../middleware/validate");
const {
  createRuleSchema,
  updateRuleSchema,
  idParamSchema,
  listEventsSchema,
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
// rule can't be pointed at somebody else's Instagram.
async function ownsIgAccount(accountId, igUserId) {
  const onAccount = await Account.exists({
    _id: accountId,
    "ig_oauth.ig_user_id": igUserId,
  });
  if (onAccount) return true;

  return !!(await OutboundAccount.exists({
    account_id: accountId,
    "ig_oauth.ig_user_id": igUserId,
  }));
}

// ─── GET /api/comment-rules/ig-accounts — connectable IG accounts ────────────
router.get("/ig-accounts", async (req, res) => {
  try {
    const account = await Account.findById(req.account._id)
      .select("ig_oauth.ig_user_id ig_oauth.ig_username")
      .lean();

    const outbound = await OutboundAccount.find({
      account_id: req.account._id,
      "ig_oauth.ig_user_id": { $ne: null },
    })
      .select("ig_oauth.ig_user_id ig_oauth.ig_username")
      .lean();

    const accounts = [];
    if (account?.ig_oauth?.ig_user_id) {
      accounts.push({
        ig_user_id: account.ig_oauth.ig_user_id,
        ig_username: account.ig_oauth.ig_username,
        kind: "account",
      });
    }
    for (const ob of outbound) {
      accounts.push({
        ig_user_id: ob.ig_oauth.ig_user_id,
        ig_username: ob.ig_oauth.ig_username,
        kind: "outbound",
      });
    }

    res.json({ accounts });
  } catch (err) {
    logger.error("[comment-rules] ig-accounts error:", err);
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

const mongoose = require("mongoose");

const CommentRuleSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    // IG business account this rule listens on (matches Account/OutboundAccount ig_oauth.ig_user_id)
    ig_user_id: { type: String, required: true },
    name: { type: String, default: null },

    // Empty = every post on the account. Otherwise only these media IDs.
    media_ids: [{ type: String }],
    keywords: [{ type: String }],
    match_mode: { type: String, enum: ["partial", "whole"], default: "partial" },

    // Private reply (the DM). {{firstName}} / {{username}} / {{link}} are substituted.
    dm_text: { type: String, required: true },
    link_url: { type: String, default: null },

    // Optional public reply on the comment itself. Rotated to avoid IG spam heuristics.
    reply_publicly: { type: Boolean, default: false },
    public_replies: [{ type: String }],

    active: { type: Boolean, default: true },

    // Counters (denormalized for the rules list — the source of truth is CommentEvent)
    matched_count: { type: Number, default: 0 },
    sent_count: { type: Number, default: 0 },
  },
  { collection: "comment_rules", versionKey: false, timestamps: true },
);

CommentRuleSchema.index({ account_id: 1, createdAt: -1 });
CommentRuleSchema.index({ ig_user_id: 1, active: 1 });

module.exports = mongoose.model("CommentRule", CommentRuleSchema);

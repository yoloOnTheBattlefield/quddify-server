const mongoose = require("mongoose");

// One document per comment we reacted to. Serves three jobs at once:
//   1. idempotency — Meta redelivers webhooks, and IG allows only ONE private
//      reply per comment, so a duplicate send is unrecoverable
//   2. the durable send queue (status/attempts/next_attempt_at)
//   3. the activity log shown in the UI
const CommentEventSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    rule_id: { type: mongoose.Schema.Types.ObjectId, ref: "CommentRule", default: null },
    ig_user_id: { type: String, required: true },

    comment_id: { type: String, required: true },
    media_id: { type: String, default: null },
    comment_text: { type: String, default: null },
    matched_keyword: { type: String, default: null },

    commenter_ig_id: { type: String, default: null },
    commenter_username: { type: String, default: null },

    lead_id: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },

    status: {
      type: String,
      enum: ["queued", "sent", "failed", "skipped"],
      default: "queued",
    },
    skip_reason: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    next_attempt_at: { type: Date, default: () => new Date() },
    error: { type: String, default: null },
    sent_at: { type: Date, default: null },
    public_replied: { type: Boolean, default: false },
  },
  { collection: "comment_events", versionKey: false, timestamps: true },
);

// Idempotency guard — one event per comment, full stop.
CommentEventSchema.index({ comment_id: 1 }, { unique: true });
CommentEventSchema.index({ status: 1, next_attempt_at: 1 });
CommentEventSchema.index({ account_id: 1, createdAt: -1 });
// Backs the trailing-hour rate-limit count
CommentEventSchema.index({ ig_user_id: 1, status: 1, sent_at: -1 });

module.exports = mongoose.model("CommentEvent", CommentEventSchema);

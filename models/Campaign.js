const mongoose = require("mongoose");

const CampaignSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    name: { type: String, required: true },
    mode: {
      type: String,
      enum: ["auto", "manual"],
      default: "auto",
    },
    status: {
      type: String,
      enum: ["draft", "active", "paused", "completed"],
      default: "draft",
    },
    messages: [{ type: String }],
    outbound_account_ids: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "OutboundAccount",
      },
    ],
    schedule: {
      active_hours_start: { type: Number, default: 9 },
      active_hours_end: { type: Number, default: 21 },
      timezone: { type: String, default: "America/New_York" },
      min_delay_seconds: { type: Number, default: 60 },
      max_delay_seconds: { type: Number, default: 180 },
      burst_enabled: { type: Boolean, default: false },
      messages_per_group: { type: Number, default: 10 },
      min_group_break_seconds: { type: Number, default: 600 },
      max_group_break_seconds: { type: Number, default: 1200 },
    },
    daily_limit_per_sender: { type: Number, default: 50 },
    last_sent_at: { type: Date, default: null },
    last_sender_index: { type: Number, default: 0 },
    last_message_index: { type: Number, default: 0 },
    burst_sent_in_group: { type: Number, default: 0 },
    burst_break_until: { type: Date, default: null },
    stats: {
      total: { type: Number, default: 0 },
      pending: { type: Number, default: 0 },
      queued: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      replied: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
    },
  },
  { collection: "campaigns", versionKey: false, timestamps: true },
);

CampaignSchema.index({ account_id: 1, status: 1 });

module.exports = mongoose.model("Campaign", CampaignSchema);

const mongoose = require("mongoose");

const OutboundAccountSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    username: { type: String, required: true },
    password: { type: String, default: null },
    email: { type: String, default: null },
    emailPassword: { type: String, default: null },
    proxy: { type: String, default: null },
    status: {
      type: String,
      enum: ["new", "warming", "ready", "restricted", "disabled"],
      default: "new",
    },
    isConnectedToAISetter: { type: Boolean, default: false },
    assignedTo: { type: String, default: null },
    isBlacklisted: { type: Boolean, default: false },
    notes: { type: String, default: null },
    twoFA: { type: String, default: null },
    hidemyacc_profile_id: { type: String, default: null },
    browser_token: { type: String, default: null },
    // Sending streak tracking — enforces rest days
    // 1 day break after every 5 consecutive sending days
    // 2 day break after every 10 consecutive sending days (cycle resets)
    sending_streak: { type: Number, default: 0 },
    streak_last_send_date: { type: Date, default: null },
    streak_rest_until: { type: Date, default: null },
    warmup: {
      enabled: { type: Boolean, default: false },
      startDate: { type: Date, default: null },
      schedule: [
        {
          _id: false,
          day: { type: Number },
          cap: { type: Number },
        },
      ],
      checklist: [
        {
          _id: false,
          key: { type: String },
          label: { type: String },
          completed: { type: Boolean, default: false },
          completedAt: { type: Date, default: null },
          completedBy: { type: String, default: null },
        },
      ],
    },
  },
  { collection: "outbound_accounts", versionKey: false, timestamps: true },
);

OutboundAccountSchema.index({ account_id: 1, username: 1 }, { unique: true });
OutboundAccountSchema.index({ account_id: 1, status: 1 });
OutboundAccountSchema.index({ account_id: 1, isBlacklisted: 1 });
OutboundAccountSchema.index({ browser_token: 1 }, { unique: true, partialFilterExpression: { browser_token: { $type: "string" } } });

module.exports = mongoose.model("OutboundAccount", OutboundAccountSchema);

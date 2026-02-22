const mongoose = require("mongoose");

const SenderAccountSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    ig_username: { type: String, default: null },
    display_name: { type: String, default: null },
    browser_id: { type: String, default: null },
    outbound_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OutboundAccount",
      default: null,
    },
    daily_limit: { type: Number, default: 50 },
    status: {
      type: String,
      enum: ["online", "offline", "restricted"],
      default: "offline",
    },
    restricted_until: { type: Date, default: null },
    restriction_reason: { type: String, default: null },
    test_mode: { type: Boolean, default: false },
    last_seen: { type: Date, default: null },
    socket_id: { type: String, default: null },
  },
  { collection: "sender_accounts", versionKey: false, timestamps: true },
);

// Old index replaced at startup — see index.js migration
SenderAccountSchema.index(
  { account_id: 1, ig_username: 1 },
  { unique: true, partialFilterExpression: { ig_username: { $type: "string" } } },
);
SenderAccountSchema.index(
  { account_id: 1, browser_id: 1 },
  { unique: true, partialFilterExpression: { browser_id: { $type: "string" } } },
);
SenderAccountSchema.index({ account_id: 1, status: 1 });
SenderAccountSchema.index({ outbound_account_id: 1 }, { sparse: true });

module.exports = mongoose.model("SenderAccount", SenderAccountSchema);

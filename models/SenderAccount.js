const mongoose = require("mongoose");

const SenderAccountSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    ig_username: { type: String, required: true },
    display_name: { type: String, default: null },
    daily_limit: { type: Number, default: 50 },
    status: {
      type: String,
      enum: ["online", "offline", "restricted"],
      default: "offline",
    },
    restricted_until: { type: Date, default: null },
    restriction_reason: { type: String, default: null },
    last_seen: { type: Date, default: null },
    socket_id: { type: String, default: null },
  },
  { collection: "sender_accounts", versionKey: false, timestamps: true },
);

SenderAccountSchema.index({ account_id: 1, ig_username: 1 }, { unique: true });
SenderAccountSchema.index({ account_id: 1, status: 1 });

module.exports = mongoose.model("SenderAccount", SenderAccountSchema);

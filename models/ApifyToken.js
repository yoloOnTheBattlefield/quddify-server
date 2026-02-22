const mongoose = require("mongoose");

const ApifyTokenSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    label: { type: String, default: "" },
    token: { type: String, required: true },
    status: {
      type: String,
      enum: ["active", "limit_reached", "disabled"],
      default: "active",
    },
    last_error: { type: String, default: null },
    usage_count: { type: Number, default: 0 },
    last_used_at: { type: Date, default: null },
  },
  { collection: "apify_tokens", versionKey: false, timestamps: true },
);

ApifyTokenSchema.index({ account_id: 1, status: 1 });

module.exports = mongoose.model("ApifyToken", ApifyTokenSchema);

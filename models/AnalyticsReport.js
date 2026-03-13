const mongoose = require("mongoose");

const analyticsReportSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    type: {
      type: String,
      enum: ["on_demand", "weekly", "monthly"],
      default: "on_demand",
    },
    status: {
      type: String,
      enum: ["generating", "completed", "failed"],
      default: "generating",
    },
    date_range: {
      start: { type: Date, required: true },
      end: { type: Date, required: true },
    },
    campaign_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      default: null,
    },
    report: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    token_usage: {
      input_tokens: { type: Number, default: 0 },
      output_tokens: { type: Number, default: 0 },
    },
    error: { type: String, default: null },
    generated_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

analyticsReportSchema.index({ account_id: 1, generated_at: -1 });

module.exports = mongoose.model("AnalyticsReport", analyticsReportSchema);

const mongoose = require("mongoose");

const TrendAlertSchema = new mongoose.Schema(
  {
    video_id: { type: String, required: true },
    channel_id: { type: String, required: true },
    title: { type: String, default: null },
    url: { type: String, default: null },
    views: { type: Number, default: 0 },
    views_per_hour: { type: Number, required: true },
    published_at: { type: Date, default: null },
    detected_at: { type: Date, default: Date.now },
    threshold_used: { type: Number, default: null },
    active: { type: Boolean, default: true },
  },
  { collection: "trend_alerts", versionKey: false, timestamps: true },
);

TrendAlertSchema.index({ views_per_hour: -1 });
TrendAlertSchema.index({ active: 1, detected_at: -1 });

module.exports = mongoose.model("TrendAlert", TrendAlertSchema);

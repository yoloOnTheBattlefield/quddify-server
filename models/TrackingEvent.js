const mongoose = require("mongoose");

const TrackingEventSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    lead_id: { type: String, required: true },
    event_type: { type: String, enum: ["first_visit", "page_view", "conversion"], required: true },
    url: { type: String, default: null },
    referrer: { type: String, default: null },
    user_agent: { type: String, default: null },
  },
  { collection: "tracking_events", versionKey: false, timestamps: true },
);

TrackingEventSchema.index({ account_id: 1, lead_id: 1, event_type: 1 });
TrackingEventSchema.index({ account_id: 1, createdAt: -1 });

module.exports = mongoose.model("TrackingEvent", TrackingEventSchema);

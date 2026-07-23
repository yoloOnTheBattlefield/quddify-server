const mongoose = require("mongoose");

// TEMP debug: stores raw GHL webhook payloads so we can inspect the real shape
// (which field/tag signals "link sent"). TTL-expires after 24h. Remove once the
// link-sent signal is confirmed.
const GhlWebhookLogSchema = new mongoose.Schema(
  {
    endpoint: { type: String, default: null },
    contact_id: { type: String, default: null },
    body: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 },
  },
  { strict: false, versionKey: false, collection: "ghl_webhook_logs" },
);

module.exports =
  mongoose.models.GhlWebhookLog || mongoose.model("GhlWebhookLog", GhlWebhookLogSchema);

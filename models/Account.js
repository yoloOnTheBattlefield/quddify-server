const mongoose = require("mongoose");

const AccountSchema = new mongoose.Schema(
  {
    name: { type: String, default: null },
    ghl: { type: String, default: null },
    calendly: { type: String, default: null },
    calendly_token: { type: String, default: null },
    ghl_lead_booked_webhook: { type: String, default: null },
    openai_token: { type: String, default: null },
    claude_token: { type: String, default: null },
    gemini_token: { type: String, default: null },
    has_outbound: { type: Boolean, default: false },
    has_research: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    api_key: { type: String, unique: true, sparse: true },
    tracking_enabled: { type: Boolean, default: false },
    tracking_conversion_rules: [{ type: String }],
    ig_session: {
      ig_username: { type: String, default: null },
      session_id: { type: String, default: null },
      csrf_token: { type: String, default: null },
      ds_user_id: { type: String, default: null },
    },
    ig_sessions: [
      {
        ig_username: { type: String, required: true },
        session_id: { type: String },
        csrf_token: { type: String },
        ds_user_id: { type: String },
        added_at: { type: Date, default: Date.now },
      },
    ],
    ig_proxy: { type: String, default: null },
    apify_token: { type: String, default: null },
    deleted: { type: Boolean, default: false },
    deleted_at: { type: Date, default: null },
  },
  { collection: "accounts", versionKey: false },
);

module.exports = mongoose.model("Account", AccountSchema);

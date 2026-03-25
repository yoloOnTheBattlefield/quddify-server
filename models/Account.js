const mongoose = require("mongoose");
const { encrypt, decrypt } = require("../utils/crypto");

const AccountSchema = new mongoose.Schema(
  {
    name: { type: String, default: null },
    ghl: { type: String, default: null },
    calendly: { type: String, default: null },
    calendly_token: { type: String, default: null },
    calendly_user_uri: { type: String, default: null },
    ghl_lead_booked_webhook: { type: String, default: null },
    stripe_webhook_secret: { type: String, default: null },
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
    ig_oauth: {
      access_token: { type: String, default: null },
      page_access_token: { type: String, default: null },
      page_id: { type: String, default: null },
      ig_user_id: { type: String, default: null },
      ig_username: { type: String, default: null },
      connected_at: { type: Date, default: null },
    },
    ig_proxy: { type: String, default: null },
    apify_token: { type: String, default: null },
    replicate_token: { type: String, default: null },
    deleted: { type: Boolean, default: false },
    deleted_at: { type: Date, default: null },
    push_notifications_enabled: { type: Boolean, default: true },
    telegram_bot_token: { type: String, default: null },
    telegram_chat_id: { type: String, default: null },
  },
  { collection: "accounts", versionKey: false },
);

// ---------- Encryption helpers for sensitive tokens ----------

const ENCRYPTED_FIELDS = [
  "openai_token",
  "claude_token",
  "gemini_token",
  "apify_token",
  "replicate_token",
  "calendly_token",
  "ig_oauth.access_token",
  "ig_oauth.page_access_token",
  "stripe_webhook_secret",
  "telegram_bot_token",
];

/**
 * Encrypts a plaintext value for storage.
 */
AccountSchema.statics.encryptField = function (value) {
  return encrypt(value);
};

/**
 * Decrypts an encrypted value (returns plaintext if not encrypted).
 */
AccountSchema.statics.decryptField = function (value) {
  return decrypt(value);
};

/**
 * Returns the list of field paths that should be encrypted.
 */
AccountSchema.statics.ENCRYPTED_FIELDS = ENCRYPTED_FIELDS;

module.exports = mongoose.model("Account", AccountSchema);

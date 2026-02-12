const mongoose = require("mongoose");

const AccountSchema = new mongoose.Schema(
  {
    ghl: { type: String, default: null },
    calendly: { type: String, default: null },
    calendly_token: { type: String, default: null },
    ghl_lead_booked_webhook: { type: String, default: null },
    openai_token: { type: String, default: null },
    disabled: { type: Boolean, default: false },
    api_key: { type: String, default: null, unique: true, sparse: true },
  },
  { collection: "accounts", versionKey: false },
);

module.exports = mongoose.model("Account", AccountSchema);

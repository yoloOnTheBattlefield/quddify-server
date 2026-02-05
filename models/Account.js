const mongoose = require("mongoose");

const AccountSchema = new mongoose.Schema(
  {
    ghl: String,
    first_name: String,
    last_name: String,
    email: String,
    password: String,
    calendly: String,
    calendly_token: String,
    ghl_lead_booked_webhook: { type: String, default: null },
  },
  { collection: "accounts", versionKey: false },
);

module.exports = mongoose.model("Account", AccountSchema);

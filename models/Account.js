const mongoose = require("mongoose");

const AccountSchema = new mongoose.Schema(
  {
    ghl: String,
    first_name: String,
    last_name: String,
    email: String,
    password: String,
  },
  { collection: "accounts", versionKey: false },
);

module.exports = mongoose.model("Account", AccountSchema);

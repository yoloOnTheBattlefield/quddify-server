const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },
    first_name: { type: String, default: null },
    last_name: { type: String, default: null },
    email: { type: String, required: true },
    password: { type: String, required: true },
    role: { type: Number, default: 1 },
    has_outbound: { type: Boolean, default: false },
  },
  { collection: "users", versionKey: false },
);

module.exports = mongoose.model("User", UserSchema);

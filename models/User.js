const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    first_name: { type: String, default: null },
    last_name: { type: String, default: null },
    email: { type: String, required: true },
    password: { type: String, required: true },
    role: { type: Number, default: 1 },
  },
  { collection: "users", versionKey: false },
);

module.exports = mongoose.model("User", UserSchema);

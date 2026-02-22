const mongoose = require("mongoose");

const AccountUserSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    role: { type: Number, default: 2 }, // 0=admin, 1=owner, 2=member
    has_outbound: { type: Boolean, default: false },
    has_research: { type: Boolean, default: true },
    is_default: { type: Boolean, default: false },
  },
  { collection: "account_users", versionKey: false, timestamps: true },
);

AccountUserSchema.index({ user_id: 1, account_id: 1 }, { unique: true });
AccountUserSchema.index({ user_id: 1 });
AccountUserSchema.index({ account_id: 1 });

module.exports = mongoose.model("AccountUser", AccountUserSchema);

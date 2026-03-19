const mongoose = require("mongoose");

const PushSubscriptionSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    endpoint: { type: String, required: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
  },
  { collection: "push_subscriptions", versionKey: false, timestamps: { createdAt: "created_at" } },
);

PushSubscriptionSchema.index({ account_id: 1 });
PushSubscriptionSchema.index({ endpoint: 1 }, { unique: true });

module.exports = mongoose.model("PushSubscription", PushSubscriptionSchema);

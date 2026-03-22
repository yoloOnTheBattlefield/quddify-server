const mongoose = require("mongoose");

const PaymentSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    lead_id: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    outbound_lead_id: { type: mongoose.Schema.Types.ObjectId, ref: "OutboundLead", default: null },
    stripe_event_id: { type: String, required: true },
    stripe_event_type: { type: String, required: true },
    amount: { type: Number, required: true }, // in cents
    currency: { type: String, default: "usd" },
    customer_email: { type: String, default: null },
    customer_name: { type: String, default: null },
    description: { type: String, default: null },
    stripe_customer_id: { type: String, default: null },
    stripe_payment_intent_id: { type: String, default: null },
    payment_date: { type: Date, required: true },
  },
  { collection: "payments", timestamps: true, versionKey: false },
);

PaymentSchema.index({ account_id: 1, lead_id: 1 });
PaymentSchema.index({ stripe_event_id: 1 }, { unique: true });
PaymentSchema.index({ account_id: 1, customer_email: 1 });

module.exports = mongoose.model("Payment", PaymentSchema);

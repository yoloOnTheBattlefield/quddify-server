const mongoose = require("mongoose");

const BookingSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    lead_id: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    outbound_lead_id: { type: mongoose.Schema.Types.ObjectId, ref: "OutboundLead", default: null },
    source: { type: String, enum: ["inbound", "outbound"], default: "outbound" },
    contact_name: { type: String, default: "" },
    ig_username: { type: String, default: null },
    email: { type: String, default: null },
    booking_date: { type: Date, required: true },
    status: { type: String, enum: ["scheduled", "completed", "no_show", "cancelled"], default: "scheduled" },
    cash_collected: { type: Number, default: null },
    contract_value: { type: Number, default: null },
    notes: { type: String, default: "" },
    cancelled_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
    score: { type: Number, default: null },
  },
  { collection: "bookings", timestamps: true, versionKey: false },
);

BookingSchema.index({ account_id: 1, booking_date: -1 });
BookingSchema.index({ account_id: 1, status: 1 });
BookingSchema.index({ lead_id: 1 });
BookingSchema.index({ outbound_lead_id: 1 });

module.exports = mongoose.model("Booking", BookingSchema);

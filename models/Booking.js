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
    utm_source: { type: String, default: null },
    utm_medium: { type: String, default: null },
    utm_campaign: { type: String, default: null },
    calendly_event_uri: { type: String, default: null },
    calendly_invitee_uri: { type: String, default: null },
    fathom_recording_url: { type: String, default: null },
    fathom_recording_id: { type: String, default: null },
  },
  { collection: "bookings", timestamps: true, versionKey: false },
);

BookingSchema.index({ account_id: 1, booking_date: -1 });
BookingSchema.index({ account_id: 1, status: 1 });
BookingSchema.index({ lead_id: 1 });
BookingSchema.index({ outbound_lead_id: 1 });
BookingSchema.index({ account_id: 1, utm_source: 1 });
BookingSchema.index({ calendly_event_uri: 1 }, { sparse: true });

module.exports = mongoose.model("Booking", BookingSchema);

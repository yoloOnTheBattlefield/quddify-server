const mongoose = require("mongoose");

const LeadSchema = new mongoose.Schema(
  {
    first_name: { type: String, default: null },
    last_name: { type: String, default: null },
    contact_id: { type: String, default: null },
    date_created: { type: String, default: null },
    account_id: { type: String, default: null },
    ghosted_at: { type: Date, default: null },
    booked_at: { type: Date, default: null },
    booking_at: { type: Date, default: null },
    qualified_at: { type: Date, default: null },
    follow_up_at: { type: Date, default: null },
    link_sent_at: { type: Date, default: null },
    low_ticket: { type: Date, default: null },
    summary: { type: String, default: null },
    email: { type: String, default: null },
  },
  {
    collection: "leads",
    versionKey: false,
  },
);

module.exports = mongoose.model("Lead", LeadSchema);

const mongoose = require("mongoose");

const LeadSchema = new mongoose.Schema(
  {
    first_name: { type: String, default: null },
    last_name: { type: String, default: null },
    contact_id: { type: String, default: null },
    date_created: { type: String, default: null },
    account_id: { type: String, default: null },
    ghosted_at: { type: Date, default: null },
    booked_at: { type: Date, default: null }, // booking has been made
    booking_at: { type: Date, default: null }, // booking has been made
    qualified_at: { type: Date, default: null },
    follow_up_at: { type: Date, default: null }, // follow up before sending the link
    link_sent_at: { type: Date, default: null }, // link was sent
    low_ticket: { type: Date, default: null },
    summary: { type: String, default: null },
    email: { type: String, default: null },
    questions_and_answers: { type: Array, default: [] },
  },
  {
    collection: "leads",
    versionKey: false,
    bufferCommands: true,
  },
);

module.exports = mongoose.model("Lead", LeadSchema);

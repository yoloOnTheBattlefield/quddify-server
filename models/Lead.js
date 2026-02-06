const mongoose = require("mongoose");

const LeadSchema = new mongoose.Schema(
  {
    first_name: { type: String, default: null },
    last_name: { type: String, default: null },
    contact_id: { type: String, default: null },
    account_id: { type: String, default: null },

    // ghl tags
    date_created: { type: String, default: null }, // when the lead entered the system
    ghosted_at: { type: Date, default: null },
    qualified_at: { type: Date, default: null }, // happens before sending the link (not always present)
    link_sent_at: { type: Date, default: null }, // link was sent
    booked_at: { type: Date, default: null }, // booking has been made
    follow_up_at: { type: Date, default: null }, // follow up before sending the link
    low_ticket: { type: Date, default: null },
    // ai tags
    summary: { type: String, default: null },
    //calendly
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

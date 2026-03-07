const mongoose = require("mongoose");

const LeadSchema = new mongoose.Schema(
  {
    first_name: { type: String, default: null },
    last_name: { type: String, default: null },
    contact_id: { type: String, default: null },
    account_id: { type: String, default: null },
    ig_username: { type: String, default: null },
    source: { type: String, default: null },
    post_url: { type: String, default: null },
    outbound_lead_id: { type: mongoose.Schema.Types.ObjectId, ref: "OutboundLead", default: null },
    ig_thread_id: { type: String, default: null },

    // ghl tags
    date_created: { type: String, default: null }, // when the lead entered the system
    ghosted_at: { type: Date, default: null },
    link_sent_at: { type: Date, default: null }, // link was sent
    link_clicked_at: { type: Date, default: null }, // lead clicked the link and visited the site
    booked_at: { type: Date, default: null }, // booking has been made
    follow_up_at: { type: Date, default: null }, // follow up before sending the link
    low_ticket: { type: Date, default: null },
    // sales
    score: { type: Number, default: null }, // 1-10, null = not set
    contract_value: { type: Number, default: null }, // in dollars
    closed_at: { type: Date, default: null }, // payment made
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

LeadSchema.index({ account_id: 1, date_created: -1 });
LeadSchema.index({ account_id: 1, link_sent_at: -1 });
LeadSchema.index({ account_id: 1, booked_at: -1 });
LeadSchema.index({ ig_username: 1, account_id: 1 });

module.exports = mongoose.model("Lead", LeadSchema);

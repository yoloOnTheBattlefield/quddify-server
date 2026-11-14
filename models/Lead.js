const mongoose = require("mongoose");

const STAGES = ["new", "qualifying", "pain", "teaser", "pitched", "negotiating", "booked", "won", "lost"];
const PITCH_OFFERS = ["sprint_5k", "consult_500"];
const LEAD_MAGNET_STATUSES = ["none", "posted", "building", "built", "sent"];
const SOURCE_TYPES = ["story", "reel", "post", "comment", "organic", "other"];

const LeadSchema = new mongoose.Schema(
  {
    first_name: { type: String, default: null },
    last_name: { type: String, default: null },
    contact_id: { type: String, default: null },
    account_id: { type: String, default: null },
    ig_username: { type: String, default: null },
    platform: { type: String, enum: ["instagram", "linkedin"], default: "instagram" },
    source: { type: String, default: null },
    post_url: { type: String, default: null },
    outbound_lead_id: { type: mongoose.Schema.Types.ObjectId, ref: "OutboundLead", default: null },
    ig_thread_id: { type: String, default: null },

    // legacy tags
    date_created: { type: String, default: null }, // when the lead entered the system
    messaged_at: { type: Date, default: null }, // setter sent the first message
    replied_at: { type: Date, default: null }, // lead replied
    ghosted_at: { type: Date, default: null },
    disqualified_at: { type: Date, default: null }, // not a fit
    disqualified_reason: { type: String, default: null },
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
    // legacy conversation transcript
    chat_memory: { type: String, default: null },
    //calendly
    email: { type: String, default: null },
    questions_and_answers: { type: Array, default: [] },
    // utm attribution
    utm_source: { type: String, default: null },
    utm_medium: { type: String, default: null },
    utm_campaign: { type: String, default: null },
    // conversation timestamps
    last_conversation_at: { type: Date, default: null },
    first_conversation_at: { type: Date, default: null },
    conversation_count: { type: Number, default: 0 },
    // additional emails for matching (Stripe, etc.)
    emails: [{ type: String }],

    // ── IG CRM agent fields (Grokbot) ──
    ig_user_id: { type: String, default: null }, // participant's IG scoped id
    zernio_conversation_id: { type: String, default: null },
    stage: { type: String, enum: STAGES, default: "new" },
    stage_history: {
      type: [
        {
          _id: false,
          from: { type: String, default: null },
          to: { type: String, required: true },
          at: { type: Date, default: Date.now },
          by: { type: String, default: null },
        },
      ],
      default: [],
    },
    skip: { type: Boolean, default: false },
    skip_reason: { type: String, default: null },
    language: { type: String, enum: ["en", "ro", null], default: null },
    industry: { type: String, default: null },
    offer: { type: String, default: null }, // what they sell
    buyer: { type: String, default: null }, // who they sell to
    ticket_size: { type: String, default: null },
    monthly_revenue: { type: String, default: null },
    monthly_revenue_usd: { type: Number, default: null },
    pain: { type: String, default: null },
    pitch: {
      offer: { type: String, enum: [...PITCH_OFFERS, null], default: null },
      amount: { type: Number, default: null },
      counter: { type: String, default: null },
      at: { type: Date, default: null },
    },
    lead_magnet: {
      status: { type: String, enum: LEAD_MAGNET_STATUSES, default: "none" },
      brief: { type: String, default: null },
      ideas: { type: String, default: null },
      doc_url: { type: String, default: null },
      slack_posted_at: { type: Date, default: null },
      sent_at: { type: Date, default: null },
    },
    // Where the lead came from (first touch). source_media_id joins to MediaInsight.media_id.
    source_type: { type: String, enum: [...SOURCE_TYPES, null], default: null },
    source_label: { type: String, default: null },
    source_media_id: { type: String, default: null },
    source_url: { type: String, default: null },
    live_until: { type: Date, default: null }, // Cristian is replying live until
    last_inbound_at: { type: Date, default: null },
    last_outbound_at: { type: Date, default: null },
    last_bot_send_at: { type: Date, default: null },
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
LeadSchema.index({ contact_id: 1 });
LeadSchema.index({ account_id: 1, email: 1 });
LeadSchema.index({ outbound_lead_id: 1 });
LeadSchema.index({ account_id: 1, source_media_id: 1 });
LeadSchema.index({ account_id: 1, ig_user_id: 1 });
LeadSchema.index({ account_id: 1, zernio_conversation_id: 1 });
LeadSchema.index({ account_id: 1, stage: 1, last_inbound_at: 1 });
LeadSchema.index({ account_id: 1, skip: 1 });
LeadSchema.index({ account_id: 1, "lead_magnet.status": 1 });

module.exports = mongoose.model("Lead", LeadSchema);
module.exports.STAGES = STAGES;
module.exports.PITCH_OFFERS = PITCH_OFFERS;
module.exports.LEAD_MAGNET_STATUSES = LEAD_MAGNET_STATUSES;
module.exports.SOURCE_TYPES = SOURCE_TYPES;

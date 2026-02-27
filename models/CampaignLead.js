const mongoose = require("mongoose");

const CampaignLeadSchema = new mongoose.Schema(
  {
    campaign_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
    },
    outbound_lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OutboundLead",
      required: true,
    },
    sender_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SenderAccount",
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "queued", "sent", "delivered", "replied", "failed", "skipped"],
      default: "pending",
    },
    sent_at: { type: Date, default: null },
    message_used: { type: String, default: null },
    template_index: { type: Number, default: null },
    task_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      default: null,
    },
    error: { type: String, default: null },
    queued_at: { type: Date, default: null },
    manually_overridden: { type: Boolean, default: false },
    overridden_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },
    overridden_at: { type: Date, default: null },
    custom_message: { type: String, default: null },
    ai_provider: { type: String, default: null },
    failed_sender_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "SenderAccount" }],
  },
  { collection: "campaign_leads", versionKey: false, timestamps: true },
);

CampaignLeadSchema.index(
  { campaign_id: 1, outbound_lead_id: 1 },
  { unique: true },
);
CampaignLeadSchema.index({ campaign_id: 1, status: 1 });
CampaignLeadSchema.index({ sender_id: 1 });

module.exports = mongoose.model("CampaignLead", CampaignLeadSchema);

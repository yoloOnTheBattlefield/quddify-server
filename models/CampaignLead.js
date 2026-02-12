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
      enum: ["pending", "queued", "sent", "failed", "skipped"],
      default: "pending",
    },
    sent_at: { type: Date, default: null },
    message_used: { type: String, default: null },
    task_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      default: null,
    },
    error: { type: String, default: null },
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

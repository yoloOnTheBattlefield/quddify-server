const mongoose = require("mongoose");

const TaskSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    type: {
      type: String,
      enum: ["send_dm", "follow", "unfollow", "comment_post"],
      required: true,
    },
    target: { type: String, required: true },
    outbound_lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OutboundLead",
      default: null,
    },
    sender_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SenderAccount",
      default: null,
    },
    campaign_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      default: null,
    },
    campaign_lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CampaignLead",
      default: null,
    },
    message: { type: String, default: null },
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed", "failed"],
      default: "pending",
    },
    result: {
      success: { type: Boolean, default: null },
      username: { type: String, default: null },
      threadId: { type: String, default: null },
      timestamp: { type: Date, default: null },
    },
    error: {
      error: { type: String, default: null },
      errorType: { type: String, default: null },
      stackTrace: { type: String, default: null },
      timestamp: { type: Date, default: null },
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  { collection: "tasks", versionKey: false, timestamps: true },
);

TaskSchema.index({ account_id: 1, status: 1, createdAt: 1 });
TaskSchema.index({ account_id: 1, sender_id: 1, status: 1, createdAt: 1 });

module.exports = mongoose.model("Task", TaskSchema);

const mongoose = require("mongoose");

const WarmupLogSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    outbound_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OutboundAccount",
      required: true,
    },
    action: {
      type: String,
      enum: [
        "warmup_started",
        "warmup_stopped",
        "checklist_toggled",
        "warmup_completed",
        "cap_enforced",
      ],
      required: true,
    },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    performedBy: { type: String, default: "system" },
  },
  { collection: "warmup_logs", versionKey: false, timestamps: true },
);

WarmupLogSchema.index({ outbound_account_id: 1, createdAt: -1 });

module.exports = mongoose.model("WarmupLog", WarmupLogSchema);

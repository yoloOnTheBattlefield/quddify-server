const mongoose = require("mongoose");

const FollowUpSchema = new mongoose.Schema(
  {
    outbound_lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OutboundLead",
      required: true,
    },
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    outbound_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OutboundAccount",
      default: null,
    },
    status: {
      type: String,
      enum: [
        "new",
        "contacted",
        "interested",
        "not_interested",
        "booked",
        "no_response",
        "ghosted",
        "hot_lead",
      ],
      default: "new",
    },
    follow_up_date: { type: Date, default: null },
    note: { type: String, default: "" },
  },
  { collection: "follow_ups", versionKey: false, timestamps: true },
);

FollowUpSchema.index(
  { outbound_lead_id: 1, account_id: 1 },
  { unique: true },
);
FollowUpSchema.index({ account_id: 1, status: 1 });
FollowUpSchema.index({ account_id: 1, follow_up_date: 1 });
FollowUpSchema.index({ account_id: 1, outbound_account_id: 1 });

module.exports = mongoose.model("FollowUp", FollowUpSchema);

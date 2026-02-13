const mongoose = require("mongoose");

const OutboundLeadSchema = new mongoose.Schema(
  {
    followingKey: { type: String, required: true },
    username: { type: String, unique: true },
    fullName: { type: String, default: null },
    profileLink: { type: String, default: null },
    isVerified: { type: Boolean, default: null },
    followersCount: { type: Number, default: null },
    bio: { type: String, default: null },
    postsCount: { type: Number, default: null },
    externalUrl: { type: String, default: null },
    email: { type: String, default: null },
    source: { type: String, default: null },
    scrapeDate: { type: Date, default: null },
    ig: { type: String, default: null },
    qualified: { type: Boolean, default: false },
    promptId: { type: mongoose.Schema.Types.ObjectId, ref: "Prompt", default: null },
    promptLabel: { type: String, default: null },
    isMessaged: { type: Boolean, default: null },
    dmDate: { type: Date, default: null },
    message: { type: String, default: null },
    ig_thread_id: { type: String, default: null },
    replied: { type: Boolean, default: false },
    booked: { type: Boolean, default: false },
    contract_value: { type: Number, default: null },
    metadata: {
      source: { type: String },
      executionId: { type: String },
      syncedAt: { type: Date },
    },
  },
  { collection: "outbound_leads", versionKey: false, timestamps: true },
);

OutboundLeadSchema.index({ promptId: 1 });

module.exports = mongoose.model("OutboundLead", OutboundLeadSchema);

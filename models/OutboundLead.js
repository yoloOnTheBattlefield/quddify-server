const mongoose = require("mongoose");

const OutboundLeadSchema = new mongoose.Schema(
  {
    followingKey: { type: String, required: true, unique: true },
    username: { type: String },
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
    isMessaged: { type: Boolean, default: null },
    dmDate: { type: Date, default: null },
    message: { type: String, default: null },
    metadata: {
      source: { type: String },
      executionId: { type: String },
      syncedAt: { type: Date },
    },
  },
  { collection: "outbound_leads", versionKey: false, timestamps: true },
);

module.exports = mongoose.model("OutboundLead", OutboundLeadSchema);

const mongoose = require("mongoose");

const igConversationSchema = new mongoose.Schema(
  {
    instagram_thread_id: {
      type: String,
      required: true,
      unique: true,
    },
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },
    outbound_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OutboundAccount",
      default: null,
    },
    owner_ig_user_id: {
      type: String,
      default: null,
    },
    lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },
    outbound_lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OutboundLead",
      default: null,
    },
    participant_ids: {
      type: [String],
      required: true,
    },
    participant_usernames: {
      type: Map,
      of: String,
      default: {},
    },
    last_message_at: {
      type: Date,
      default: null,
    },
  },
  {
    collection: "ig_conversations",
    timestamps: { createdAt: "created_at", updatedAt: false },
    versionKey: false,
  },
);

igConversationSchema.index({ last_message_at: -1 });
igConversationSchema.index({ account_id: 1, last_message_at: -1 });
igConversationSchema.index({ outbound_account_id: 1, last_message_at: -1 });

module.exports = mongoose.model("IgConversation", igConversationSchema);

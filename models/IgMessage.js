const mongoose = require("mongoose");

const igMessageSchema = new mongoose.Schema(
  {
    conversation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IgConversation",
      required: true,
    },
    sender_id: {
      type: String,
      required: true,
    },
    recipient_id: {
      type: String,
      required: true,
    },
    message_text: {
      type: String,
      default: null,
    },
    message_id: {
      type: String,
      required: true,
      unique: true,
    },
    timestamp: {
      type: Date,
      required: true,
    },
    raw_payload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    read_at: {
      type: Date,
      default: null,
    },
  },
  {
    collection: "ig_messages",
    timestamps: { createdAt: "created_at", updatedAt: false },
    versionKey: false,
  },
);

igMessageSchema.index({ conversation_id: 1, timestamp: 1 });
igMessageSchema.index({ sender_id: 1 });

module.exports = mongoose.model("IgMessage", igMessageSchema);

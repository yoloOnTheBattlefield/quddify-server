const mongoose = require("mongoose");

const igAttachmentSchema = new mongoose.Schema(
  {
    conversation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IgConversation",
      required: true,
    },
    message_id: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      required: true,
    },
    payload_url: {
      type: String,
      default: null,
    },
  },
  {
    collection: "ig_attachments",
    timestamps: { createdAt: "created_at", updatedAt: false },
    versionKey: false,
  },
);

igAttachmentSchema.index({ conversation_id: 1 });
igAttachmentSchema.index({ message_id: 1 });

module.exports = mongoose.model("IgAttachment", igAttachmentSchema);

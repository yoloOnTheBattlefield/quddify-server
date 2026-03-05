const mongoose = require("mongoose");

const igConversationSchema = new mongoose.Schema(
  {
    instagram_thread_id: {
      type: String,
      required: true,
      unique: true,
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

module.exports = mongoose.model("IgConversation", igConversationSchema);

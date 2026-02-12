const mongoose = require("mongoose");

const PromptSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    label: { type: String, required: true },
    promptText: { type: String, required: true },
    isDefault: { type: Boolean, default: false },
    filters: {
      minFollowers: { type: Number, default: 40000 },
      minPosts: { type: Number, default: 10 },
      excludePrivate: { type: Boolean, default: true },
      verifiedOnly: { type: Boolean, default: false },
      bioRequired: { type: Boolean, default: false },
    },
  },
  { collection: "prompts", versionKey: false, timestamps: true },
);

module.exports = mongoose.model("Prompt", PromptSchema);

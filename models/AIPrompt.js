const mongoose = require("mongoose");

const AIPromptSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    name: { type: String, required: true },
    promptText: { type: String, required: true },
  },
  { collection: "ai_prompts", versionKey: false, timestamps: true },
);

AIPromptSchema.index({ account_id: 1, createdAt: -1 });

module.exports = mongoose.model("AIPrompt", AIPromptSchema);

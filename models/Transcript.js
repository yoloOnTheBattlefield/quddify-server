const mongoose = require("mongoose");

const InsightSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    strength: { type: Number, default: 5 },
  },
  { _id: false },
);

const QuoteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    speaker: { type: String, default: "" },
    strength: { type: Number, default: 5 },
  },
  { _id: false },
);

const EmotionalPeakSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    emotion: { type: String, default: "" },
    intensity: { type: Number, default: 5 },
  },
  { _id: false },
);

const TopicClusterSchema = new mongoose.Schema(
  {
    topic: { type: String, required: true },
    excerpts: [{ type: String }],
    strength: { type: Number, default: 5 },
  },
  { _id: false },
);

const TranscriptSchema = new mongoose.Schema(
  {
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    title: { type: String, required: true },
    raw_text: { type: String, required: true },
    call_type: {
      type: String,
      enum: ["sales_call", "coaching_call", "content_brainstorm", "generic", "custom"],
      default: "generic",
    },
    custom_tag: { type: String, default: null },
    ai_model: { type: String, enum: ["gpt-4o", "gpt-4o-mini", "claude-sonnet"], default: "gpt-4o" },
    extracted: {
      pain_points: [InsightSchema],
      desires: [InsightSchema],
      objections: [InsightSchema],
      quotes: [QuoteSchema],
      story_moments: [{ text: { type: String }, emotional_weight: { type: Number, default: 5 }, _id: false }],
      teaching_moments: [{ text: { type: String }, clarity: { type: Number, default: 5 }, _id: false }],
      cta_opportunities: [{ text: { type: String }, fit: { type: Number, default: 5 }, _id: false }],
      emotional_peaks: [EmotionalPeakSchema],
      topic_clusters: [TopicClusterSchema],
    },
    overall_strength: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "processing", "ready", "failed"], default: "pending" },
  },
  { collection: "transcripts", versionKey: false, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

TranscriptSchema.index({ client_id: 1, status: 1 });
TranscriptSchema.index({ client_id: 1, overall_strength: -1 });

module.exports = mongoose.model("Transcript", TranscriptSchema);

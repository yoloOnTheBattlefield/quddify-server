const mongoose = require("mongoose");

const SlideStructureSchema = new mongoose.Schema(
  {
    slide_number: { type: Number, required: true },
    type: { type: String, enum: ["hook", "pain", "solution", "proof", "teaching", "cta", "bridge", "agitate"], default: "hook" },
    text_placement: { type: String, default: "center" },
    has_image: { type: Boolean, default: true },
  },
  { _id: false },
);

const SwipeFileSchema = new mongoose.Schema(
  {
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", default: null },
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    source_url: { type: String, default: null },
    source_type: { type: String, enum: ["own_post", "competitor", "inspiration"], default: "inspiration" },
    title: { type: String, required: true },
    screenshot_keys: [{ type: String }],
    style_profile: {
      style_name: { type: String, default: "" },
      hook_style: { type: String, default: "" },
      slide_count: { type: Number, default: 0 },
      text_density: { type: String, enum: ["minimal", "moderate", "heavy"], default: "moderate" },
      visual_style: { type: String, default: "" },
      layout_rhythm: { type: String, default: "" },
      cta_pattern: { type: String, default: "" },
      headline_format: { type: String, default: "" },
      color_mood: { type: String, default: "" },
      pacing: { type: String, default: "" },
      slide_structure: [SlideStructureSchema],
    },
    engagement_score: { type: Number, default: null },
    reuse_count: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "processing", "ready", "failed"], default: "pending" },
  },
  { collection: "swipe_files", versionKey: false, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

SwipeFileSchema.index({ account_id: 1 });
SwipeFileSchema.index({ client_id: 1 });

module.exports = mongoose.model("SwipeFile", SwipeFileSchema);

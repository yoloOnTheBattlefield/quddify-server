const mongoose = require("mongoose");

const CarouselSlideSchema = new mongoose.Schema(
  {
    position: { type: Number, required: true },
    role: { type: String, default: "hook" },
    composition: {
      type: String,
      enum: ["single_hero", "split_collage", "grid_2x2", "before_after", "lifestyle_grid", "text_only"],
      default: "single_hero",
    },
    copy: { type: String, default: "" },
    copy_why: { type: String, default: "" },
    image_id: { type: mongoose.Schema.Types.ObjectId, ref: "ClientImage", default: null },
    image_key: { type: String, default: "" },
    extra_image_keys: [{ type: String }],
    is_ai_generated_image: { type: Boolean, default: false },
    rendered_key: { type: String, default: "" },
    image_selection_reason: { type: String, default: "" },
  },
  { _id: false },
);

const CarouselSchema = new mongoose.Schema(
  {
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    transcript_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "Transcript" }],
    swipe_file_id: { type: mongoose.Schema.Types.ObjectId, ref: "SwipeFile", default: null },
    template_id: { type: mongoose.Schema.Types.ObjectId, ref: "CarouselTemplate", default: null },
    lut_id: { type: mongoose.Schema.Types.ObjectId, ref: "ClientLut", default: null },
    goal: {
      type: String,
      enum: ["saveable_educational", "polarizing_authority", "emotional_story", "conversion_focused"],
      default: "saveable_educational",
    },
    slides: [CarouselSlideSchema],
    caption: { type: String, default: "" },
    hashtags: [{ type: String }],
    confidence: {
      overall: { type: Number, default: 0 },
      transcript_strength: { type: Number, default: 0 },
      hook_strength: { type: Number, default: 0 },
      image_copy_fit: { type: Number, default: 0 },
      brand_fit: { type: Number, default: 0 },
      style_fit: { type: Number, default: 0 },
      image_quality_avg: { type: Number, default: 0 },
      ai_image_ratio: { type: Number, default: 0 },
      cta_fit: { type: Number, default: 0 },
      save_potential: { type: Number, default: 0 },
      dm_potential: { type: Number, default: 0 },
      explanation: { type: String, default: "" },
    },
    angle: {
      chosen_angle: { type: String, default: "" },
      angle_type: { type: String, default: "" },
      supporting_excerpts: [{ type: String }],
      hook_options: [{ type: String }],
      why_this_angle: { type: String, default: "" },
    },
    strategy_notes: { type: String, default: "" },
    status: { type: String, enum: ["queued", "generating", "ready", "failed"], default: "queued" },
    generation_log: [{ type: String }],
    exported_at: { type: Date, default: null },
  },
  { collection: "carousels", versionKey: false, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

CarouselSchema.index({ client_id: 1, created_at: -1 });
CarouselSchema.index({ account_id: 1, status: 1 });

module.exports = mongoose.model("Carousel", CarouselSchema);

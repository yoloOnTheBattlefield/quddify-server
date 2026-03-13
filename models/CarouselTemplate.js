const mongoose = require("mongoose");

const SlideTemplateSchema = new mongoose.Schema(
  {
    position: { type: Number, required: true },
    role: { type: String, enum: ["hook", "pain", "agitate", "solution", "proof", "teaching", "bridge", "cta"], required: true },
    copy_instruction: { type: String, default: "" },
    tone_note: { type: String, default: null },
  },
  { _id: false },
);

const CarouselTemplateSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", default: null },
    name: { type: String, required: true },
    type: { type: String, enum: ["content_structure", "visual", "reference_derived"], required: true },
    source_swipe_file_id: { type: mongoose.Schema.Types.ObjectId, ref: "SwipeFile", default: null },
    content_structure: {
      slide_count: { type: Number, default: 7 },
      slides: [SlideTemplateSchema],
      hook_formula: { type: String, default: null },
      cta_formula: { type: String, default: null },
    },
    visual_structure: {
      background_style: { type: String, enum: ["solid_color", "gradient", "image_full", "image_partial", "dark_overlay"], default: "dark_overlay" },
      text_position: { type: String, enum: ["center", "top", "bottom", "left", "right"], default: "center" },
      text_style: {
        size: { type: String, enum: ["large", "medium", "small"], default: "large" },
        weight: { type: String, enum: ["bold", "semibold", "normal"], default: "bold" },
        case: { type: String, enum: ["uppercase", "normal", "mixed"], default: "uppercase" },
        alignment: { type: String, enum: ["center", "left"], default: "center" },
      },
      image_treatment: { type: String, enum: ["full_bleed", "rounded_inset", "side_by_side", "background_blur", "none"], default: "full_bleed" },
      overlay_opacity: { type: Number, default: 0.4 },
      accent_elements: [{ type: String }],
    },
    layout_preset: {
      mode: { type: String, enum: ["uniform", "sequence", "ai_suggested"], default: "ai_suggested" },
      default_composition: {
        type: String,
        enum: ["single_hero", "split_collage", "grid_2x2", "before_after", "lifestyle_grid", "text_only"],
        default: "single_hero",
      },
      sequence: [
        {
          position: { type: Number },
          composition: {
            type: String,
            enum: ["single_hero", "split_collage", "grid_2x2", "before_after", "lifestyle_grid", "text_only"],
          },
        },
      ],
    },
    is_default: { type: Boolean, default: false },
  },
  { collection: "carousel_templates", versionKey: false, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

CarouselTemplateSchema.index({ account_id: 1, type: 1 });

module.exports = mongoose.model("CarouselTemplate", CarouselTemplateSchema);

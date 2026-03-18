const mongoose = require("mongoose");

const ThumbnailTemplateSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null }, // null = system default
    name: { type: String, required: true },
    description: { type: String, default: "" },
    preview_key: { type: String, default: null }, // storage key for preview image

    layout: {
      // Person placement
      person_position: { type: String, enum: ["right", "left", "center", "split"], default: "right" },
      person_crop: { type: String, enum: ["face", "shoulders", "waist", "full"], default: "shoulders" },
      person_frame_pct: { type: Number, default: 40 }, // how much of the frame the person takes

      // For split layouts (before/after with two faces)
      split: {
        enabled: { type: Boolean, default: false },
        left_expression: { type: String, default: "" }, // e.g. "neutral or slightly unhappy"
        right_expression: { type: String, default: "" }, // e.g. "smiling or confident"
        arrow: { type: Boolean, default: false }, // show arrow between sides
      },

      // Text placement
      text_position: { type: String, enum: ["left", "center", "upper-left", "upper-right", "bottom-left"], default: "left" },
      text_stack: {
        enabled: { type: Boolean, default: false },
        top_line: { type: String, default: "" }, // e.g. "small setup text"
        middle_line: { type: String, default: "" }, // e.g. "main result — biggest element"
        bottom_line: { type: String, default: "" }, // e.g. "time constraint or method"
      },

      // Background
      background_style: { type: String, enum: ["dark-environment", "gradient", "solid-dark", "split-color"], default: "dark-environment" },
      color_direction: { type: String, default: "" }, // e.g. "red background for urgency"
    },

    // The actual prompt instructions that get injected
    prompt_instructions: { type: String, required: true },

    is_system: { type: Boolean, default: false }, // system defaults can't be edited
  },
  { collection: "thumbnail_templates", versionKey: false, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

ThumbnailTemplateSchema.index({ account_id: 1 });

module.exports = mongoose.model("ThumbnailTemplate", ThumbnailTemplateSchema);

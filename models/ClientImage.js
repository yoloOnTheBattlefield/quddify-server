const mongoose = require("mongoose");

const ClientImageSchema = new mongoose.Schema(
  {
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    storage_key: { type: String, required: true },
    thumbnail_key: { type: String, default: null },
    original_filename: { type: String, default: "" },
    mime_type: { type: String, default: "image/jpeg" },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    file_size: { type: Number, default: 0 },
    tags: {
      emotion: [{ type: String }],
      context: [{ type: String }],
      body_language: [{ type: String }],
      facial_expression: [{ type: String }],
      setting: [{ type: String }],
      clothing: [{ type: String }],
      activity: [{ type: String }],
      vibe: [{ type: String }],
      lighting: [{ type: String }],
      color_palette: [{ type: String }],
      composition: [{ type: String }],
    },
    quality_score: { type: Number, default: 0 },
    face_visibility_score: { type: Number, default: 0 },
    energy_level: { type: Number, default: 0 },
    text_safe_zones: {
      top: { type: Boolean, default: false },
      bottom: { type: Boolean, default: false },
      left: { type: Boolean, default: false },
      right: { type: Boolean, default: false },
    },
    subject_position: { type: String, default: "center" },
    aspect_ratio: { type: Number, default: 1 },
    is_portrait: { type: Boolean, default: true },
    suitable_as_cover: { type: Boolean, default: false },
    is_ai_generated: { type: Boolean, default: false },
    total_uses: { type: Number, default: 0 },
    last_used_at: { type: Date, default: null },
    used_in_carousels: [{ type: mongoose.Schema.Types.ObjectId }],
    status: { type: String, enum: ["processing", "ready", "failed", "archived"], default: "processing" },
    source: { type: String, enum: ["google_drive", "manual_upload", "ai_generated", "prospect_scrape"], default: "manual_upload" },
    prospect_profile_id: { type: mongoose.Schema.Types.ObjectId, ref: "ProspectProfile", default: null },
    google_drive_file_id: { type: String, default: null },
    summary: { type: String, default: "" },
  },
  { collection: "client_images", versionKey: false, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

ClientImageSchema.index({ client_id: 1, status: 1 });
ClientImageSchema.index({ client_id: 1, "tags.emotion": 1 });
ClientImageSchema.index({ client_id: 1, "tags.context": 1 });
ClientImageSchema.index({ client_id: 1, last_used_at: 1 });
ClientImageSchema.index({ client_id: 1, suitable_as_cover: 1, quality_score: -1 });
ClientImageSchema.index({ prospect_profile_id: 1, status: 1 });

module.exports = mongoose.model("ClientImage", ClientImageSchema);

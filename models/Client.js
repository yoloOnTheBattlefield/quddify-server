const mongoose = require("mongoose");

const ClientSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    email: { type: String, default: null },
    niche: { type: String, default: "fitness" },
    sales_rep_name: { type: String, default: "Jorden" },
    brand_kit: {
      primary_color: { type: String, default: "#000000" },
      secondary_color: { type: String, default: "#ffffff" },
      accent_color: { type: String, default: "#3b82f6" },
      font_heading: { type: String, default: "Montserrat" },
      font_body: { type: String, default: "Inter" },
      text_color_light: { type: String, default: "#ffffff" },
      text_color_dark: { type: String, default: "#000000" },
      logo_url: { type: String, default: null },
      style_notes: { type: String, default: "" },
    },
    voice_profile: {
      raw_text: { type: String, default: "" },
    },
    cta_defaults: {
      primary_cta: { type: String, default: "DM me 'READY'" },
      secondary_cta: { type: String, default: "Save this for later" },
      cta_enabled: { type: Boolean, default: true },
    },
    special_instructions: { type: String, default: "" },
    niche_playbook: { type: String, default: "" },
    google_drive_folder_id: { type: String, default: null },
    google_drive_sync_token: { type: String, default: null },
    ig_username: { type: String, default: null },
    ig_bio: { type: String, default: null },
    ig_profile_picture_url: { type: String, default: null },
    ig_oauth: {
      access_token: { type: String, default: null },
      page_access_token: { type: String, default: null },
      page_id: { type: String, default: null },
      ig_user_id: { type: String, default: null },
      ig_username: { type: String, default: null },
      connected_at: { type: Date, default: null },
    },
    ai_integrations: {
      claude_token: { type: String, default: null },
      openai_token: { type: String, default: null },
      gemini_token: { type: String, default: null },
    },
    face_reference_images: [{ type: String }],
  },
  { collection: "clients", versionKey: false, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

ClientSchema.index({ account_id: 1 });
ClientSchema.index({ slug: 1, account_id: 1 }, { unique: true });

module.exports = mongoose.model("Client", ClientSchema);

const { z } = require("zod");

const create = z.object({
  body: z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    password: z.string().min(6).optional(),
    niche: z.string().optional(),
    sales_rep_name: z.string().optional(),
    brand_kit: z.object({
      primary_color: z.string().optional(),
      secondary_color: z.string().optional(),
      accent_color: z.string().optional(),
      font_heading: z.string().optional(),
      font_body: z.string().optional(),
      text_color_light: z.string().optional(),
      text_color_dark: z.string().optional(),
      style_notes: z.string().optional(),
    }).optional(),
    voice_profile: z.object({
      raw_text: z.string().optional(),
    }).optional(),
    cta_defaults: z.object({
      primary_cta: z.string().optional(),
      secondary_cta: z.string().optional(),
      cta_enabled: z.boolean().optional(),
    }).optional(),
  }),
});

const update = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    niche: z.string().optional(),
    sales_rep_name: z.string().optional(),
    brand_kit: z.object({
      primary_color: z.string().optional(),
      secondary_color: z.string().optional(),
      accent_color: z.string().optional(),
      font_heading: z.string().optional(),
      font_body: z.string().optional(),
      text_color_light: z.string().optional(),
      text_color_dark: z.string().optional(),
      logo_url: z.string().nullable().optional(),
      style_notes: z.string().optional(),
    }).optional(),
    voice_profile: z.object({
      raw_text: z.string().optional(),
    }).optional(),
    cta_defaults: z.object({
      primary_cta: z.string().optional(),
      secondary_cta: z.string().optional(),
      cta_enabled: z.boolean().optional(),
    }).optional(),
    special_instructions: z.string().optional(),
    ai_integrations: z.object({
      claude_token: z.string().nullable().optional(),
      openai_token: z.string().nullable().optional(),
      gemini_token: z.string().nullable().optional(),
    }).optional(),
    ig_username: z.string().nullable().optional(),
    ig_bio: z.string().nullable().optional(),
    ig_profile_picture_url: z.string().nullable().optional(),
    google_drive_folder_id: z.string().nullable().optional(),
    face_reference_images: z.array(z.string()).optional(),
  }),
  params: z.object({
    id: z.string().min(1),
  }),
});

module.exports = { create, update };

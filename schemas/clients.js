const { z } = require("zod");

const create = z.object({
  body: z.object({
    name: z.string().min(1),
    slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
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
      tone: z.string().optional(),
      vocabulary_level: z.enum(["simple", "moderate", "advanced"]).optional(),
      phrases_to_use: z.array(z.string()).optional(),
      phrases_to_avoid: z.array(z.string()).optional(),
      example_copy: z.string().optional(),
      personality_notes: z.string().optional(),
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
      tone: z.string().optional(),
      vocabulary_level: z.enum(["simple", "moderate", "advanced"]).optional(),
      phrases_to_use: z.array(z.string()).optional(),
      phrases_to_avoid: z.array(z.string()).optional(),
      example_copy: z.string().optional(),
      personality_notes: z.string().optional(),
    }).optional(),
    cta_defaults: z.object({
      primary_cta: z.string().optional(),
      secondary_cta: z.string().optional(),
      cta_enabled: z.boolean().optional(),
    }).optional(),
    google_drive_folder_id: z.string().nullable().optional(),
    face_reference_images: z.array(z.string()).optional(),
  }),
  params: z.object({
    id: z.string().min(1),
  }),
});

module.exports = { create, update };

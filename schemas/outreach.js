const { z } = require("zod");

const scrape = z.object({
  body: z.object({
    ig_handle: z.string().min(1),
    client_id: z.string().min(1),
    direct_urls: z.array(z.string().url()).optional(),
  }),
}).passthrough();

const updateProfile = z.object({
  body: z.object({
    profile: z
      .object({
        name: z.string().optional(),
        niche: z.string().optional(),
        offer: z.string().optional(),
        audience: z.string().optional(),
        core_message: z.string().optional(),
        voice_notes: z.string().optional(),
        content_angles: z.array(z.string()).optional(),
        cta_style: z
          .object({
            mechanism: z.enum(["comment_keyword", "link_in_bio", "dm_trigger", "custom", "uncertain"]).optional(),
            detected_cta: z.string().optional(),
            confidence: z.number().min(0).max(1).optional(),
          })
          .optional(),
      })
      .optional(),
    inferred_brand: z
      .object({
        primary_color: z.string().optional(),
        secondary_color: z.string().optional(),
        accent_color: z.string().optional(),
        style_notes: z.string().optional(),
      })
      .optional(),
  }),
}).passthrough();

const generate = z.object({
  body: z.object({
    topic: z.string().min(1).optional(),
    goal: z.enum(["saveable_educational", "polarizing_authority", "emotional_story", "conversion_focused"]).optional(),
    slide_count: z.number().min(5).max(11).optional(),
    additional_instructions: z.string().optional(),
  }),
}).passthrough();

module.exports = { scrape, updateProfile, generate };

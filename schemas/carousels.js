const { z } = require("zod");

const generate = z.object({
  body: z.object({
    client_id: z.string().min(1),
    transcript_ids: z.array(z.string().min(1)).min(1),
    swipe_file_id: z.string().nullable().optional(),
    template_id: z.string().nullable().optional(),
    lut_id: z.string().nullable().optional(),
    goal: z.enum(["saveable_educational", "polarizing_authority", "emotional_story", "conversion_focused"]).optional(),
    copy_model: z.enum(["claude-sonnet", "claude-opus", "gpt-4o"]).optional(),
    style_id: z.string().nullable().optional(),
    style_prompt_override: z.string().nullable().optional(),
    layout_preset: z.object({
      mode: z.enum(["uniform", "sequence", "ai_suggested"]),
      default_composition: z.enum(["single_hero", "split_collage", "grid_2x2", "before_after", "lifestyle_grid", "text_only"]).optional(),
      sequence: z.array(z.object({
        position: z.number(),
        composition: z.enum(["single_hero", "split_collage", "grid_2x2", "before_after", "lifestyle_grid", "text_only"]),
      })).optional(),
    }).optional(),
  }),
});

const generateBrief = z.object({
  body: z.object({
    client_id: z.string().min(1),
    transcript_ids: z.array(z.string().min(1)).min(1),
    goal: z.enum(["saveable_educational", "polarizing_authority", "emotional_story", "conversion_focused"]).optional(),
  }),
});

const generateFromTopic = z.object({
  body: z.object({
    client_id: z.string().min(1),
    topic: z.string().min(1),
    goal: z.enum(["saveable_educational", "polarizing_authority", "emotional_story", "conversion_focused"]).optional(),
    slide_count: z.number().min(5).max(20).optional(),
    additional_instructions: z.string().optional(),
    show_brand_name: z.boolean().optional(),
  }),
});

module.exports = { generate, generateBrief, generateFromTopic };

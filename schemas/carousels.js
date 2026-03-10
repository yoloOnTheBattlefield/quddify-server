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
  }),
});

module.exports = { generate };

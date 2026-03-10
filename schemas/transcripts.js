const { z } = require("zod");

const create = z.object({
  body: z.object({
    client_id: z.string().min(1),
    title: z.string().min(1),
    raw_text: z.string().min(1),
    call_type: z.enum(["sales_call", "coaching_call", "content_brainstorm", "generic", "custom"]).optional(),
    custom_tag: z.string().nullable().optional(),
    ai_model: z.enum(["gpt-4o", "gpt-4o-mini", "claude-sonnet"]).optional(),
  }),
});

module.exports = { create };

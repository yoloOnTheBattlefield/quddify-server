const { z } = require("zod");

const webhookSchema = z.object({
  body: z.object({
    ig_username: z.string().min(1, "ig_username is required"),
    first_name: z.string().optional().nullable(),
    last_name: z.string().optional().nullable(),
    full_name: z.string().optional().nullable(),
    trigger_type: z.string().optional().nullable(),
    post_url: z.string().optional().nullable(),
  }),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

module.exports = { webhookSchema };

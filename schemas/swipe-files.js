const { z } = require("zod");

const create = z.object({
  body: z.object({
    client_id: z.string().nullable().optional(),
    title: z.string().min(1),
    source_url: z.string().nullable().optional(),
    source_type: z.enum(["own_post", "competitor", "inspiration"]).optional(),
  }),
});

module.exports = { create };

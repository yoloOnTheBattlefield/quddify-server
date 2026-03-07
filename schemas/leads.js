const { z } = require("zod");

const leadCreateSchema = z.object({
  body: z.object({
    first_name: z.string().optional().nullable(),
    last_name: z.string().optional().nullable(),
    account_id: z.string().optional().nullable(),
    ig_username: z.string().optional().nullable(),
    email: z.string().email().optional().nullable(),
  }).passthrough(),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

const leadUpdateSchema = z.object({
  body: z.object({
    score: z.number().min(1).max(10).optional().nullable(),
    contract_value: z.number().min(0).optional().nullable(),
  }).passthrough(),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

module.exports = { leadCreateSchema, leadUpdateSchema };

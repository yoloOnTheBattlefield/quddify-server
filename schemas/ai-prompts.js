const { z } = require("zod");

const aiPromptCreateSchema = z.object({
  body: z.object({
    name: z.string().min(1, "name is required"),
    promptText: z.string().min(1, "promptText is required"),
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

const aiPromptUpdateSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    promptText: z.string().min(1).optional(),
  }).passthrough(),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

module.exports = { aiPromptCreateSchema, aiPromptUpdateSchema };

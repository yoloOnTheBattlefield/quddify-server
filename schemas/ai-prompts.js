const { z } = require("zod");

const aiPromptCreateSchema = z.object({
  body: z.object({
    name: z.string().min(1, "name is required"),
    promptText: z.string().min(1, "promptText is required"),
  }),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

const aiPromptUpdateSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    promptText: z.string().min(1).optional(),
  }).strip(),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

module.exports = { aiPromptCreateSchema, aiPromptUpdateSchema };

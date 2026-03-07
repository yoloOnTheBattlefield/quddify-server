const { z } = require("zod");

const promptCreateSchema = z.object({
  body: z.object({
    label: z.string().min(1, "label is required"),
    promptText: z.string().min(1, "promptText is required"),
    isDefault: z.boolean().optional(),
    filters: z.object({
      minFollowers: z.number().optional(),
      minPosts: z.number().optional(),
      excludePrivate: z.boolean().optional(),
      verifiedOnly: z.boolean().optional(),
      bioRequired: z.boolean().optional(),
    }).optional(),
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

const promptUpdateSchema = z.object({
  body: z.object({
    label: z.string().min(1).optional(),
    promptText: z.string().min(1).optional(),
    isDefault: z.boolean().optional(),
    filters: z.object({
      minFollowers: z.number().optional(),
      minPosts: z.number().optional(),
      excludePrivate: z.boolean().optional(),
      verifiedOnly: z.boolean().optional(),
      bioRequired: z.boolean().optional(),
    }).optional(),
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

module.exports = { promptCreateSchema, promptUpdateSchema };

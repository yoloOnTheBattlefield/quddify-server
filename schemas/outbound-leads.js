const { z } = require("zod");

const bulkDeleteSchema = z.object({
  body: z.object({
    ids: z.array(z.string()).optional(),
    all: z.boolean().optional(),
    filters: z.object({
      source: z.string().optional(),
      isMessaged: z.string().optional(),
      replied: z.string().optional(),
      booked: z.string().optional(),
      promptLabel: z.string().optional(),
      qualified: z.string().optional(),
      search: z.string().optional(),
    }).optional(),
  }).refine(
    (data) => (data.ids && data.ids.length > 0) || (data.all && data.filters),
    { message: "Provide ids array or all+filters" }
  ),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

const patchLeadSchema = z.object({
  body: z.object({
    username: z.string().optional(),
    fullName: z.string().optional().nullable(),
    bio: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    source: z.string().optional(),
    followersCount: z.number().optional().nullable(),
    postsCount: z.number().optional().nullable(),
    isMessaged: z.boolean().optional().nullable(),
    replied: z.boolean().optional().nullable(),
    booked: z.boolean().optional().nullable(),
    link_sent: z.boolean().optional().nullable(),
    link_sent_at: z.any().optional().nullable(),
    booked_at: z.any().optional().nullable(),
    replied_at: z.any().optional().nullable(),
    dmDate: z.any().optional().nullable(),
    message: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    contract_value: z.number().optional().nullable(),
    score: z.number().optional().nullable(),
    qualified: z.boolean().optional().nullable(),
    promptId: z.string().optional().nullable(),
    promptLabel: z.string().optional().nullable(),
    follow_up_status: z.string().optional().nullable(),
    follow_up_notes: z.string().optional().nullable(),
  }).strip(),
  query: z.object({}).strip(),
  params: z.object({
    id: z.string().min(1, "Lead ID is required"),
  }),
});

module.exports = { bulkDeleteSchema, patchLeadSchema };

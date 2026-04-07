const { z } = require("zod");

const leadCreateSchema = z.object({
  body: z.object({
    first_name: z.string().optional().nullable(),
    last_name: z.string().optional().nullable(),
    // account_id is intentionally NOT accepted here — the route forces it
    // from the authenticated session to prevent cross-tenant writes.
    contact_id: z.string().optional().nullable(),
    ig_username: z.string().optional().nullable(),
    email: z.string().email().optional().nullable(),
    source: z.string().optional().nullable(),
    summary: z.string().optional().nullable(),
    date_created: z.string().optional().nullable(),
    score: z.number().min(1).max(10).optional().nullable(),
    contract_value: z.number().min(0).optional().nullable(),
    // Stage dates — the add-lead modal sets these when the user picks an
    // initial status (link_sent / booked / closed).
    link_sent_at: z.string().datetime().optional().nullable(),
    follow_up_at: z.string().datetime().optional().nullable(),
    booked_at: z.string().datetime().optional().nullable(),
    ghosted_at: z.string().datetime().optional().nullable(),
    closed_at: z.string().datetime().optional().nullable(),
  }).strip(),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

const leadUpdateSchema = z.object({
  body: z.object({
    first_name: z.string().optional().nullable(),
    last_name: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    emails: z.array(z.string()).optional(),
    ig_username: z.string().optional().nullable(),
    source: z.string().optional().nullable(),
    score: z.number().min(1).max(10).optional().nullable(),
    contract_value: z.number().min(0).optional().nullable(),
    outbound_lead_id: z.string().optional().nullable(),
    ig_thread_id: z.string().optional().nullable(),
    // Stage dates
    link_sent_at: z.string().datetime().optional().nullable(),
    follow_up_at: z.string().datetime().optional().nullable(),
    booked_at: z.string().datetime().optional().nullable(),
    ghosted_at: z.string().datetime().optional().nullable(),
    closed_at: z.string().datetime().optional().nullable(),
  }).strip(),
  query: z.object({}).strip(),
  params: z.object({ id: z.string() }).strip(),
});

module.exports = { leadCreateSchema, leadUpdateSchema };

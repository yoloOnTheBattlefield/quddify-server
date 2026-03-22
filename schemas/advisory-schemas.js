const { z } = require("zod");

const createClientSchema = z.object({
  body: z.object({
    name: z.string().min(1, "name is required"),
    niche: z.string().optional(),
    monthly_revenue: z.number().optional(),
    runway: z.number().optional(),
    constraint_type: z
      .enum(["delegation", "psychological", "conversion", "content", "systems", "ads"])
      .optional(),
    status: z.enum(["active", "paused", "churned"]).optional(),
    health: z.enum(["green", "amber", "red"]).optional(),
    next_call_date: z.string().optional(),
    notes: z.string().optional(),
  }),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

const updateClientSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    niche: z.string().optional(),
    monthly_revenue: z.number().optional(),
    runway: z.number().optional(),
    constraint_type: z
      .enum(["delegation", "psychological", "conversion", "content", "systems", "ads"])
      .optional(),
    status: z.enum(["active", "paused", "churned"]).optional(),
    health: z.enum(["green", "amber", "red"]).optional(),
    next_call_date: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
  }),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

const createSessionSchema = z.object({
  body: z.object({
    client_id: z.string().min(1, "client_id is required"),
    session_date: z.string().min(1, "session_date is required"),
    fathom_url: z.string().optional(),
    bottleneck_identified: z.string().optional(),
    summary: z.string().optional(),
    action_items: z
      .array(
        z.object({
          task: z.string().optional(),
          owner: z.string().optional(),
          due_date: z.string().optional(),
          completed: z.boolean().optional(),
        }),
      )
      .optional(),
  }),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

const updateSessionSchema = z.object({
  body: z.object({
    session_date: z.string().optional(),
    fathom_url: z.string().optional(),
    bottleneck_identified: z.string().optional(),
    summary: z.string().optional(),
    action_items: z
      .array(
        z.object({
          _id: z.string().optional(),
          task: z.string().optional(),
          owner: z.string().optional(),
          due_date: z.string().optional(),
          completed: z.boolean().optional(),
        }),
      )
      .optional(),
  }),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

const upsertMetricSchema = z.object({
  body: z.object({
    client_id: z.string().min(1, "client_id is required"),
    month: z
      .string()
      .min(1, "month is required")
      .regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM format"),
    cash_collected: z.number().optional(),
    mrr: z.number().optional(),
    calls_booked: z.number().optional(),
    calls_showed: z.number().optional(),
    calls_closed: z.number().optional(),
    expenses: z.number().optional(),
  }),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

module.exports = {
  createClientSchema,
  updateClientSchema,
  createSessionSchema,
  updateSessionSchema,
  upsertMetricSchema,
};

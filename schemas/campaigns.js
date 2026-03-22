const { z } = require("zod");

const createCampaignSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Campaign name is required"),
    mode: z.enum(["auto", "manual"]).optional(),
    messages: z.array(z.any()).optional(),
    outbound_account_ids: z.array(z.string()).optional(),
    schedule: z.object({
      active_hours_start: z.number().min(0).max(23).optional(),
      active_hours_end: z.number().min(0).max(23).optional(),
      days_of_week: z.array(z.number().min(0).max(6)).optional(),
      timezone: z.string().optional(),
      burst_enabled: z.boolean().optional(),
      messages_per_group: z.number().min(1).optional(),
      min_delay_seconds: z.number().min(10).optional(),
      max_delay_seconds: z.number().optional(),
      min_group_break_seconds: z.number().optional(),
      max_group_break_seconds: z.number().optional(),
      skip_active_hours: z.boolean().optional(),
    }).strip().optional(),
    daily_limit_per_sender: z.number().int().positive().optional(),
  }),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

const patchCampaignSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Campaign name cannot be empty").optional(),
    mode: z.enum(["auto", "manual"]).optional(),
    messages: z.array(z.any()).optional(),
    outbound_account_ids: z.array(z.string()).optional(),
    schedule: z.object({
      active_hours_start: z.number().min(0).max(23).optional(),
      active_hours_end: z.number().min(0).max(23).optional(),
      days_of_week: z.array(z.number().min(0).max(6)).optional(),
      timezone: z.string().optional(),
      burst_enabled: z.boolean().optional(),
      messages_per_group: z.number().min(1).optional(),
      min_delay_seconds: z.number().min(10).optional(),
      max_delay_seconds: z.number().optional(),
      min_group_break_seconds: z.number().optional(),
      max_group_break_seconds: z.number().optional(),
      skip_active_hours: z.boolean().optional(),
    }).strip().optional(),
    daily_limit_per_sender: z.number().int().positive().optional(),
  }).strip(),
  query: z.object({}).strip(),
  params: z.object({
    id: z.string().min(1, "Campaign ID is required"),
  }),
});

module.exports = { createCampaignSchema, patchCampaignSchema };

const { z } = require("zod");

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id");

const ruleBody = {
  ig_user_id: z.string().min(1, "ig_user_id is required"),
  name: z.string().max(120).optional().nullable(),
  media_ids: z.array(z.string().min(1)).max(200).optional(),
  keywords: z.array(z.string().min(1).max(80)).min(1, "At least one keyword is required").max(50),
  match_mode: z.enum(["partial", "whole"]).optional(),
  dm_text: z.string().min(1, "dm_text is required").max(1000),
  link_url: z.string().url("link_url must be a valid URL").optional().nullable(),
  reply_publicly: z.boolean().optional(),
  public_replies: z.array(z.string().min(1).max(300)).max(20).optional(),
  active: z.boolean().optional(),
};

const createRuleSchema = z.object({
  body: z.object(ruleBody).strip(),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

// Every field optional on update, but at least one must be present.
const updateRuleSchema = z.object({
  body: z
    .object(
      Object.fromEntries(
        Object.entries(ruleBody).map(([key, schema]) => [key, schema.optional()]),
      ),
    )
    .strip()
    .refine((body) => Object.keys(body).length > 0, {
      message: "No fields to update",
    }),
  query: z.object({}).strip(),
  params: z.object({ id: objectId }).strip(),
});

const idParamSchema = z.object({
  body: z.object({}).strip().optional(),
  query: z.object({}).strip(),
  params: z.object({ id: objectId }).strip(),
});

const listEventsSchema = z.object({
  body: z.object({}).strip().optional(),
  query: z
    .object({
      rule_id: objectId.optional(),
      status: z.enum(["queued", "sent", "failed", "skipped"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    })
    .strip(),
  params: z.object({}).strip(),
});

module.exports = { createRuleSchema, updateRuleSchema, idParamSchema, listEventsSchema };

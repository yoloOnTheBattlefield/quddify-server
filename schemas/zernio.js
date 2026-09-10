const { z } = require("zod");

const apiKey = z.string().min(20, "Zernio API key looks too short").max(200);

const listAccountsSchema = z.object({
  body: z.object({
    api_key: apiKey.optional(),
    profile_id: z.string().min(1, "profile_id is required"),
  }),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

const listProfilesSchema = z.object({
  body: z.object({ api_key: apiKey.optional() }).strip(),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

const connectSchema = z.object({
  body: z
    .object({
      api_key: apiKey.optional(),
      profile_id: z.string().min(1, "profile_id is required"),
      zernio_account_id: z.string().min(1, "zernio_account_id is required"),
      ig_user_id: z.string().min(1, "ig_user_id is required"),
      ig_username: z.string().max(120).optional().nullable(),
    })
    .strip(),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

const emptySchema = z.object({
  body: z.object({}).strip().optional(),
  query: z.object({}).strip(),
  params: z.object({}).strip(),
});

module.exports = { listProfilesSchema, listAccountsSchema, connectSchema, emptySchema };

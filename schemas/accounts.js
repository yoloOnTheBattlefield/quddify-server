const { z } = require("zod");

const loginSchema = z.object({
  body: z.object({
    email: z.string().min(1, "Email is required").email("Invalid email format"),
    password: z.string().min(1, "Password is required"),
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

const registerSchema = z.object({
  body: z.object({
    email: z.string().min(1, "Email is required").email("Invalid email format"),
    password: z.string().min(6, "Password must be at least 6 characters"),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    ghl: z.string().optional().nullable(),
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

module.exports = { loginSchema, registerSchema };

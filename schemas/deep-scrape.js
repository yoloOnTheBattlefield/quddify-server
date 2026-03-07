const { z } = require("zod");

const startDeepScrapeSchema = z.object({
  body: z.object({
    name: z.string().optional().nullable(),
    mode: z.enum(["outbound", "research"]).optional(),
    seed_usernames: z.array(z.string()).optional(),
    direct_urls: z.array(z.string()).optional(),
    scrape_type: z.enum(["reels", "posts"]).optional(),
    reel_limit: z.number().int().positive().optional(),
    comment_limit: z.number().int().positive().optional(),
    min_followers: z.number().int().min(0).optional(),
    force_reprocess: z.boolean().optional(),
    scrape_emails: z.boolean().optional(),
    prompt_id: z.string().optional().nullable(),
    is_recurring: z.boolean().optional(),
    repeat_interval_days: z.number().int().positive().optional(),
  }).refine(
    (data) =>
      (Array.isArray(data.seed_usernames) && data.seed_usernames.length > 0) ||
      (Array.isArray(data.direct_urls) && data.direct_urls.length > 0),
    { message: "Provide seed_usernames or direct_urls" }
  ),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

module.exports = { startDeepScrapeSchema };

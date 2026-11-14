const { z } = require("zod");
const { STAGES, PITCH_OFFERS, LEAD_MAGNET_STATUSES, SOURCE_TYPES } = require("../models/Lead");

const isoDate = z.string().datetime({ offset: true });
const text = z.string().trim().max(5000);

// Every field an agent may write on a contact. Anything else is a 400.
const contactFields = {
  ig_username: z.string().trim().min(1).max(100).optional(),
  ig_user_id: z.string().trim().min(1).max(64).optional(),
  zernio_conversation_id: z.string().trim().min(1).max(64).optional(),
  first_name: text.nullable().optional(),
  last_name: text.nullable().optional(),
  email: z.string().trim().max(320).nullable().optional(),
  source: z.string().trim().max(100).nullable().optional(),
  source_type: z.enum(SOURCE_TYPES).nullable().optional(),
  source_label: z.string().trim().max(200).nullable().optional(),
  source_media_id: z.string().trim().max(64).nullable().optional(),
  source_url: z.string().trim().max(2000).nullable().optional(),
  stage: z.enum(STAGES).optional(),
  skip: z.boolean().optional(),
  skip_reason: text.nullable().optional(),
  language: z.enum(["en", "ro"]).nullable().optional(),
  industry: text.nullable().optional(),
  offer: text.nullable().optional(),
  buyer: text.nullable().optional(),
  ticket_size: text.nullable().optional(),
  monthly_revenue: text.nullable().optional(),
  monthly_revenue_usd: z.number().min(0).nullable().optional(),
  pain: text.nullable().optional(),
  summary: text.nullable().optional(),
  pitch: z
    .object({
      offer: z.enum(PITCH_OFFERS).nullable().optional(),
      amount: z.number().min(0).nullable().optional(),
      counter: text.nullable().optional(),
      at: isoDate.nullable().optional(),
    })
    .strict()
    .optional(),
  lead_magnet: z
    .object({
      status: z.enum(LEAD_MAGNET_STATUSES).optional(),
      brief: text.nullable().optional(),
      ideas: text.nullable().optional(),
      doc_url: z.string().trim().max(2000).nullable().optional(),
      slack_posted_at: isoDate.nullable().optional(),
      sent_at: isoDate.nullable().optional(),
    })
    .strict()
    .optional(),
  follow_up_at: isoDate.nullable().optional(),
  contract_value: z.number().min(0).nullable().optional(),
  score: z.number().min(1).max(10).nullable().optional(),
};

const ALLOWED_CONTACT_FIELDS = Object.keys(contactFields);

const contactBody = z.object(contactFields).strict();

const messageBody = z
  .object({
    ref: z.string().trim().min(1),
    zernio_message_id: z.string().trim().min(1).max(200),
    text: z.string().max(10000),
    sent_by: z.enum(["bot", "cristian"]),
    sent_at: isoDate.optional(),
  })
  .strict();

const lockBody = z
  .object({
    run_id: z.string().trim().min(1).max(200),
    ttl_seconds: z.number().int().min(10).max(600).optional(),
  })
  .strict();

const skipsBody = z
  .object({
    refs: z.array(z.string().trim().min(1)).min(1).max(500),
    reason: text.nullable().optional(),
  })
  .strict();

module.exports = { contactBody, messageBody, lockBody, skipsBody, ALLOWED_CONTACT_FIELDS };

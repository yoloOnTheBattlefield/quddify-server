// Agent API — the state store for the Instagram DM agent (Grokbot).
//
// Every route is scoped to the authenticated account (req.account), set by the
// global auth middleware from `x-api-key`. A contact is a Lead. `:ref` is a
// Zernio conversation id, an IG scoped user id, or an @handle.
// Contract documented in docs/AGENT_API.md — keep the two in sync.
const logger = require("../utils/logger").child({ module: "agent" });
const express = require("express");

const Lead = require("../models/Lead");
const IgConversation = require("../models/IgConversation");
const IgMessage = require("../models/IgMessage");
const AgentLock = require("../models/AgentLock");
const Account = require("../models/Account");
const MediaInsight = require("../models/MediaInsight");
const escapeRegex = require("../utils/escapeRegex");
const { contactBody, messageBody, lockBody, skipsBody, ALLOWED_CONTACT_FIELDS } = require("../schemas/agent");

const router = express.Router();
const { STAGES, LEAD_MAGNET_STATUSES } = Lead;

const LIVE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_LOCK_TTL = 120;

// ─── helpers ────────────────────────────────────────────────────────────────

const accountKey = (req) => String(req.account._id);

function classifyRef(raw) {
  const ref = String(raw || "").trim();
  if (ref.startsWith("@")) return { kind: "handle", value: ref.slice(1).toLowerCase() };
  if (/^\d+$/.test(ref)) return { kind: "ig_user_id", value: ref };
  if (/^[0-9a-f]{24}$/i.test(ref)) return { kind: "conversation", value: ref };
  return { kind: "handle", value: ref.toLowerCase() };
}

// Resolution order: Zernio conversation id → IG user id → handle.
async function resolveContact(accountId, rawRef) {
  const ref = String(rawRef || "").trim();
  if (!ref) return null;
  const scope = { account_id: accountId };

  let lead = await Lead.findOne({ ...scope, zernio_conversation_id: ref });
  if (lead) return lead;

  const conv = await IgConversation.findOne({ account_id: accountId, zernio_conversation_id: ref, lead_id: { $ne: null } });
  if (conv) {
    lead = await Lead.findOne({ ...scope, _id: conv.lead_id });
    if (lead) return lead;
  }

  if (/^\d+$/.test(ref)) {
    lead = await Lead.findOne({ ...scope, ig_user_id: ref });
    if (lead) return lead;
    const byParticipant = await IgConversation.findOne({
      account_id: accountId,
      participant_ids: ref,
      lead_id: { $ne: null },
    });
    if (byParticipant) {
      lead = await Lead.findOne({ ...scope, _id: byParticipant.lead_id });
      if (lead) return lead;
    }
  }

  const handle = ref.replace(/^@/, "");
  if (handle) {
    lead = await Lead.findOne({ ...scope, ig_username: { $regex: new RegExp(`^${escapeRegex(handle)}$`, "i") } });
    if (lead) return lead;
  }
  return null;
}

function validationError(res, result) {
  const unknown = result.error.issues
    .filter((i) => i.code === "unrecognized_keys")
    .flatMap((i) => i.keys.map((k) => [...i.path, k].join(".")));
  return res.status(400).json({
    error: "Invalid body",
    ...(unknown.length ? { unknown_fields: unknown, allowed_fields: ALLOWED_CONTACT_FIELDS } : {}),
    issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

function serializeContact(lead) {
  const l = lead.toObject ? lead.toObject() : lead;
  const now = Date.now();
  return {
    id: String(l._id),
    ig_username: l.ig_username || null,
    ig_user_id: l.ig_user_id || null,
    zernio_conversation_id: l.zernio_conversation_id || null,
    first_name: l.first_name || null,
    last_name: l.last_name || null,
    email: l.email || null,
    source: l.source || null,
    source_type: l.source_type || null,
    source_label: l.source_label || null,
    source_media_id: l.source_media_id || null,
    source_url: l.source_url || null,
    stage: l.stage || "new",
    stage_history: l.stage_history || [],
    skip: !!l.skip,
    skip_reason: l.skip_reason || null,
    language: l.language || null,
    industry: l.industry || null,
    offer: l.offer || null,
    buyer: l.buyer || null,
    ticket_size: l.ticket_size || null,
    monthly_revenue: l.monthly_revenue || null,
    monthly_revenue_usd: l.monthly_revenue_usd ?? null,
    pain: l.pain || null,
    summary: l.summary || null,
    pitch: {
      offer: l.pitch?.offer || null,
      amount: l.pitch?.amount ?? null,
      counter: l.pitch?.counter || null,
      at: l.pitch?.at || null,
    },
    lead_magnet: {
      status: l.lead_magnet?.status || "none",
      brief: l.lead_magnet?.brief || null,
      ideas: l.lead_magnet?.ideas || null,
      doc_url: l.lead_magnet?.doc_url || null,
      slack_posted_at: l.lead_magnet?.slack_posted_at || null,
      sent_at: l.lead_magnet?.sent_at || null,
    },
    live: !!(l.live_until && new Date(l.live_until).getTime() > now),
    live_until: l.live_until || null,
    last_inbound_at: l.last_inbound_at || null,
    last_outbound_at: l.last_outbound_at || null,
    last_bot_send_at: l.last_bot_send_at || null,
    follow_up_at: l.follow_up_at || null,
    booked_at: l.booked_at || null,
    closed_at: l.closed_at || null,
    contract_value: l.contract_value ?? null,
    score: l.score ?? null,
    created_at: l.date_created || null,
  };
}

function serializeMessage(m) {
  return {
    id: String(m._id),
    direction: m.direction,
    sent_by: m.sent_by || (m.direction === "inbound" ? "lead" : "unknown"),
    text: m.message_text,
    at: m.timestamp,
    zernio_message_id: m.zernio_message_id || null,
  };
}

async function conversationIdsFor(accountId, lead) {
  const or = [{ lead_id: lead._id }];
  if (lead.ig_thread_id) or.push({ instagram_thread_id: lead.ig_thread_id });
  if (lead.ig_user_id) or.push({ participant_ids: lead.ig_user_id });
  if (lead.zernio_conversation_id) or.push({ zernio_conversation_id: lead.zernio_conversation_id });
  const convs = await IgConversation.find({ account_id: accountId, $or: or }).select("_id").lean();
  return convs.map((c) => c._id);
}

async function ownerIgUserId(accountId) {
  const a = await Account.findById(accountId).select("zernio.ig_user_id ig_oauth.ig_user_id").lean();
  return a?.zernio?.ig_user_id || a?.ig_oauth?.ig_user_id || null;
}

// Link existing conversations for this contact's IG id to the lead.
async function linkConversations(accountId, lead) {
  if (!lead.ig_user_id) return;
  const convs = await IgConversation.find({ account_id: accountId, participant_ids: lead.ig_user_id });
  for (const c of convs) {
    if (!c.lead_id) await IgConversation.updateOne({ _id: c._id }, { $set: { lead_id: lead._id } });
    if (!lead.ig_thread_id) {
      await Lead.updateOne({ _id: lead._id }, { $set: { ig_thread_id: c.instagram_thread_id } });
      lead.ig_thread_id = c.instagram_thread_id;
    }
  }
}

// Apply a validated body to a lead document (not saved). `by` = who changed it.
function applyContactPatch(lead, body, by = "agent") {
  const dates = ["follow_up_at"];
  for (const [key, value] of Object.entries(body)) {
    if (key === "stage" || key === "pitch" || key === "lead_magnet") continue;
    if (key === "ig_username" && value) {
      lead.ig_username = value.replace(/^@/, "");
      continue;
    }
    lead[key] = dates.includes(key) && value ? new Date(value) : value;
  }

  if (body.pitch) {
    for (const [k, v] of Object.entries(body.pitch)) {
      lead.set(`pitch.${k}`, k === "at" && v ? new Date(v) : v);
    }
  }
  if (body.lead_magnet) {
    for (const [k, v] of Object.entries(body.lead_magnet)) {
      lead.set(`lead_magnet.${k}`, (k === "slack_posted_at" || k === "sent_at") && v ? new Date(v) : v);
    }
    if (body.lead_magnet.status === "sent" && !lead.lead_magnet?.sent_at) lead.set("lead_magnet.sent_at", new Date());
  }

  if (body.stage && body.stage !== (lead.stage || "new")) {
    const now = new Date();
    lead.stage_history = [...(lead.stage_history || []), { from: lead.stage || "new", to: body.stage, at: now, by }];
    lead.stage = body.stage;
    // keep the dashboard funnel (timestamp fields) in step with the stage
    if (body.stage === "pitched" && !lead.link_sent_at) lead.link_sent_at = now;
    if (body.stage === "booked" && !lead.booked_at) lead.booked_at = now;
    if (body.stage === "won" && !lead.closed_at) lead.closed_at = now;
    if (body.stage === "lost" && !lead.disqualified_at) lead.disqualified_at = now;
    if (body.stage === "pitched" && !lead.pitch?.at) lead.set("pitch.at", now);
  }
}

// Instagram shortcode from a post/reel URL: /reel/X/, /reels/X/, /p/X/, /tv/X/.
function igShortcode(url) {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/instagram\.com\/(?:[^/?#]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

// When the agent gives a source_url but no source_media_id, find the post it points at.
async function resolveSourceMedia(lead, accountId) {
  if (!lead.source_url || lead.source_media_id) return;
  const code = igShortcode(lead.source_url);
  if (!code) return;
  const media = await MediaInsight.findOne({
    account_id: accountId,
    permalink: { $regex: new RegExp(`/(?:reels?|p|tv)/${escapeRegex(code)}(?:/|$|\\?)`, "i") },
  })
    .select("media_id")
    .lean();
  if (media) lead.source_media_id = media.media_id;
}

function newLeadFromRef(accountId, rawRef) {
  const { kind, value } = classifyRef(rawRef);
  const lead = new Lead({
    account_id: accountId,
    platform: "instagram",
    source: "agent",
    stage: "new",
    date_created: new Date().toISOString(),
  });
  if (kind === "ig_user_id") lead.ig_user_id = value;
  else if (kind === "conversation") lead.zernio_conversation_id = value;
  else lead.ig_username = value;
  return lead;
}

const notFound = (res, ref) => res.status(404).json({ error: "Contact not found", ref });

// ─── contacts ───────────────────────────────────────────────────────────────

router.get("/contacts/:ref", async (req, res) => {
  try {
    const accountId = accountKey(req);
    const lead = await resolveContact(accountId, req.params.ref);
    if (!lead) return notFound(res, req.params.ref);

    const convIds = await conversationIdsFor(accountId, lead);
    const msgs = convIds.length
      ? await IgMessage.find({ conversation_id: { $in: convIds } }).sort({ timestamp: -1 }).limit(30).lean()
      : [];
    const lock = await AgentLock.findOne({ account_id: accountId, ref_key: String(lead._id), expires_at: { $gt: new Date() } }).lean();

    res.json({
      contact: serializeContact(lead),
      messages: msgs.reverse().map(serializeMessage),
      lock: lock ? { run_id: lock.run_id, expires_at: lock.expires_at } : null,
    });
  } catch (err) {
    logger.error("GET /contacts error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

router.put("/contacts/:ref", async (req, res) => {
  const parsed = contactBody.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  try {
    const accountId = accountKey(req);
    let lead = await resolveContact(accountId, req.params.ref);
    const created = !lead;
    if (!lead) lead = newLeadFromRef(accountId, req.params.ref);
    applyContactPatch(lead, parsed.data, "agent");
    await resolveSourceMedia(lead, req.account._id);
    await lead.save();
    await linkConversations(accountId, lead);
    res.status(created ? 201 : 200).json({ created, contact: serializeContact(lead) });
  } catch (err) {
    logger.error("PUT /contacts error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

router.patch("/contacts/:ref", async (req, res) => {
  const parsed = contactBody.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  try {
    const accountId = accountKey(req);
    const lead = await resolveContact(accountId, req.params.ref);
    if (!lead) return notFound(res, req.params.ref);
    applyContactPatch(lead, parsed.data, "agent");
    await resolveSourceMedia(lead, req.account._id);
    await lead.save();
    if (parsed.data.ig_user_id) await linkConversations(accountId, lead);
    res.json({ contact: serializeContact(lead) });
  } catch (err) {
    logger.error("PATCH /contacts error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── messages ───────────────────────────────────────────────────────────────

router.post("/messages", async (req, res) => {
  const parsed = messageBody.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  const { ref, zernio_message_id, text, sent_by } = parsed.data;
  const sentAt = parsed.data.sent_at ? new Date(parsed.data.sent_at) : new Date();

  try {
    const accountId = accountKey(req);
    const lead = await resolveContact(accountId, ref);
    if (!lead) return notFound(res, ref);

    const dup = await IgMessage.findOne({
      $or: [{ zernio_message_id }, { message_id: zernio_message_id }],
    }).lean();
    if (dup) return res.json({ stored: false, duplicate: true, message: serializeMessage(dup) });

    const ownerId = await ownerIgUserId(accountId);
    const contactId = lead.ig_user_id || `agent:${lead._id}`;
    const senderId = ownerId || `account:${accountId}`;

    let convIds = await conversationIdsFor(accountId, lead);
    let conversationId = convIds[0];
    if (!conversationId) {
      const threadId = lead.ig_thread_id || [senderId, contactId].sort().join("_");
      const conv = await IgConversation.findOneAndUpdate(
        { instagram_thread_id: threadId },
        {
          $set: { account_id: req.account._id, lead_id: lead._id, last_message_at: sentAt },
          $addToSet: { participant_ids: { $each: [senderId, contactId] } },
          $setOnInsert: {
            instagram_thread_id: threadId,
            ...(lead.zernio_conversation_id ? { zernio_conversation_id: lead.zernio_conversation_id } : {}),
          },
        },
        { upsert: true, new: true },
      );
      conversationId = conv._id;
      if (!lead.ig_thread_id) lead.ig_thread_id = threadId;
    } else {
      await IgConversation.updateOne(
        { _id: conversationId },
        { $max: { last_message_at: sentAt }, $set: { lead_id: lead._id } },
      );
    }

    let doc;
    try {
      doc = await IgMessage.create({
        conversation_id: conversationId,
        account_id: req.account._id,
        direction: "outbound",
        sender_id: senderId,
        recipient_id: contactId,
        message_text: text,
        message_id: zernio_message_id,
        zernio_message_id,
        sent_by,
        timestamp: sentAt,
      });
    } catch (err) {
      if (err.code === 11000) {
        const existing = await IgMessage.findOne({ message_id: zernio_message_id }).lean();
        return res.json({ stored: false, duplicate: true, message: existing ? serializeMessage(existing) : null });
      }
      throw err;
    }

    if (!lead.last_outbound_at || sentAt > lead.last_outbound_at) lead.last_outbound_at = sentAt;
    if (!lead.messaged_at) lead.messaged_at = sentAt;
    if (sent_by === "bot" && (!lead.last_bot_send_at || sentAt > lead.last_bot_send_at)) lead.last_bot_send_at = sentAt;
    if (sent_by === "cristian") {
      const until = new Date(sentAt.getTime() + LIVE_WINDOW_MS);
      if (!lead.live_until || until > lead.live_until) lead.live_until = until;
    }
    await lead.save();

    res.status(201).json({ stored: true, duplicate: false, message: serializeMessage(doc), contact: serializeContact(lead) });
  } catch (err) {
    logger.error("POST /messages error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── events (dedupe between runs) ───────────────────────────────────────────

router.get("/events", async (req, res) => {
  try {
    const accountId = accountKey(req);
    const { ref } = req.query;
    if (!ref) return res.status(400).json({ error: "ref is required" });
    const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 10 * 60 * 1000);
    if (Number.isNaN(since.getTime())) return res.status(400).json({ error: "since must be an ISO date" });

    const lead = await resolveContact(accountId, ref);
    if (!lead) return notFound(res, ref);

    const convIds = await conversationIdsFor(accountId, lead);
    const msgs = convIds.length
      ? await IgMessage.find({ conversation_id: { $in: convIds }, timestamp: { $gte: since } }).sort({ timestamp: 1 }).lean()
      : [];
    res.json({
      since,
      messages: msgs.map(serializeMessage),
      stage_changes: (lead.stage_history || []).filter((h) => h.at >= since),
      last_bot_send_at: lead.last_bot_send_at || null,
      live: !!(lead.live_until && lead.live_until > new Date()),
    });
  } catch (err) {
    logger.error("GET /events error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── locks ──────────────────────────────────────────────────────────────────

router.post("/locks/:ref", async (req, res) => {
  const parsed = lockBody.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  const { run_id } = parsed.data;
  const ttl = parsed.data.ttl_seconds || DEFAULT_LOCK_TTL;

  try {
    const accountId = accountKey(req);
    const lead = await resolveContact(accountId, req.params.ref);
    if (!lead) return notFound(res, req.params.ref);

    const now = new Date();
    const expires = new Date(now.getTime() + ttl * 1000);
    const refKey = String(lead._id);
    try {
      const lock = await AgentLock.findOneAndUpdate(
        { account_id: accountId, ref_key: refKey, $or: [{ expires_at: { $lte: now } }, { run_id }] },
        { $set: { run_id, expires_at: expires } },
        { upsert: true, new: true },
      );
      return res.json({ acquired: true, run_id: lock.run_id, expires_at: lock.expires_at, contact_id: refKey });
    } catch (err) {
      if (err.code !== 11000) throw err;
      const held = await AgentLock.findOne({ account_id: accountId, ref_key: refKey }).lean();
      return res.status(409).json({
        acquired: false,
        held_by: held?.run_id || null,
        expires_at: held?.expires_at || null,
        contact_id: refKey,
      });
    }
  } catch (err) {
    logger.error("POST /locks error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

router.delete("/locks/:ref", async (req, res) => {
  try {
    const runId = req.body?.run_id || req.query.run_id;
    if (!runId) return res.status(400).json({ error: "run_id is required" });
    const accountId = accountKey(req);
    const lead = await resolveContact(accountId, req.params.ref);
    if (!lead) return notFound(res, req.params.ref);
    const r = await AgentLock.deleteOne({ account_id: accountId, ref_key: String(lead._id), run_id: runId });
    res.json({ released: r.deletedCount > 0 });
  } catch (err) {
    logger.error("DELETE /locks error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── follow-ups, skips, lead magnets, stats ─────────────────────────────────

function stageFilter(stages) {
  if (!stages.includes("new")) return { stage: { $in: stages } };
  return { $or: [{ stage: { $in: stages } }, { stage: null }, { stage: { $exists: false } }] };
}

router.get("/followups", async (req, res) => {
  try {
    const accountId = accountKey(req);
    const days = Math.min(Math.max(Number(req.query.days ?? 3), 0), 365);
    if (!Number.isFinite(days)) return res.status(400).json({ error: "days must be a number" });
    const stages = String(req.query.stages || "qualifying,pitched")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = stages.filter((s) => !STAGES.includes(s));
    if (bad.length) return res.status(400).json({ error: "Unknown stages", unknown: bad, allowed: STAGES });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const leads = await Lead.find({
      account_id: accountId,
      skip: { $ne: true },
      last_inbound_at: { $ne: null, $lte: cutoff },
      ...stageFilter(stages),
    })
      .sort({ last_inbound_at: 1 })
      .limit(limit);

    res.json({ days, stages, contacts: leads.map(serializeContact) });
  } catch (err) {
    logger.error("GET /followups error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/skips", async (req, res) => {
  try {
    const leads = await Lead.find({ account_id: accountKey(req), skip: true })
      .select("ig_username ig_user_id zernio_conversation_id skip_reason first_name last_name")
      .sort({ ig_username: 1 })
      .lean();
    res.json({
      skips: leads.map((l) => ({
        id: String(l._id),
        ig_username: l.ig_username || null,
        ig_user_id: l.ig_user_id || null,
        zernio_conversation_id: l.zernio_conversation_id || null,
        name: [l.first_name, l.last_name].filter(Boolean).join(" ") || null,
        skip_reason: l.skip_reason || null,
      })),
    });
  } catch (err) {
    logger.error("GET /skips error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/skips", async (req, res) => {
  const parsed = skipsBody.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  try {
    const accountId = accountKey(req);
    const results = [];
    for (const ref of parsed.data.refs) {
      let lead = await resolveContact(accountId, ref);
      const created = !lead;
      if (!lead) lead = newLeadFromRef(accountId, ref);
      lead.skip = true;
      if (parsed.data.reason !== undefined) lead.skip_reason = parsed.data.reason;
      await lead.save();
      if (created) await linkConversations(accountId, lead);
      results.push({ ref, id: String(lead._id), status: created ? "created" : "updated" });
    }
    res.json({
      updated: results.filter((r) => r.status === "updated").length,
      created: results.filter((r) => r.status === "created").length,
      results,
    });
  } catch (err) {
    logger.error("POST /skips error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/lead-magnets", async (req, res) => {
  try {
    const statuses = String(req.query.status || "posted,building")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = statuses.filter((s) => !LEAD_MAGNET_STATUSES.includes(s));
    if (bad.length) return res.status(400).json({ error: "Unknown status", unknown: bad, allowed: LEAD_MAGNET_STATUSES });
    const leads = await Lead.find({ account_id: accountKey(req), "lead_magnet.status": { $in: statuses } })
      .sort({ "lead_magnet.slack_posted_at": 1, _id: 1 })
      .limit(200);
    res.json({ statuses, contacts: leads.map(serializeContact) });
  } catch (err) {
    logger.error("GET /lead-magnets error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const accountId = accountKey(req);
    const [byStage, byMagnet, skipped] = await Promise.all([
      Lead.aggregate([
        { $match: { account_id: accountId, skip: { $ne: true } } },
        { $group: { _id: { $ifNull: ["$stage", "new"] }, n: { $sum: 1 } } },
      ]),
      Lead.aggregate([
        { $match: { account_id: accountId, skip: { $ne: true }, "lead_magnet.status": { $in: ["posted", "building", "built", "sent"] } } },
        { $group: { _id: "$lead_magnet.status", n: { $sum: 1 } } },
      ]),
      Lead.countDocuments({ account_id: accountId, skip: true }),
    ]);

    const stages = Object.fromEntries(STAGES.map((s) => [s, 0]));
    for (const r of byStage) if (r._id in stages) stages[r._id] = r.n;
    const lead_magnets = { posted: 0, building: 0, built: 0, sent: 0 };
    for (const r of byMagnet) if (r._id in lead_magnets) lead_magnets[r._id] = r.n;

    res.json({
      stages,
      total: Object.values(stages).reduce((a, b) => a + b, 0),
      skipped,
      lead_magnets,
    });
  } catch (err) {
    logger.error("GET /stats error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
module.exports.resolveContact = resolveContact;

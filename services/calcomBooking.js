const logger = require("../utils/logger").child({ module: "calcomBooking" });
const crypto = require("crypto");

const Lead = require("../models/Lead");
const Booking = require("../models/Booking");
const { notifyNewLead } = require("./telegramNotifier");
const escapeRegex = require("../utils/escapeRegex");

const TRIGGERS = ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED", "BOOKING_NO_SHOW_UPDATED"];

// ─── signature ──────────────────────────────────────────────────────────────

// Cal.com signs the raw body: X-Cal-Signature-256 = hex HMAC-SHA256(rawBody, secret).
function verifyCalcomSignature({ rawBody, signature, secret }) {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = String(signature).trim().replace(/^sha256=/, "");
  if (given.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// ─── normalising ────────────────────────────────────────────────────────────

const isHttp = (v) => typeof v === "string" && /^https?:\/\//i.test(v);

/**
 * One shape for both sources: a webhook `payload` and a v2 API booking (backfill).
 * Returns null when there's no booking uid.
 */
function normalizeBooking(p) {
  if (!p || typeof p !== "object") return null;
  const uid = p.uid || null;
  if (!uid) return null;
  const metadata = p.metadata && typeof p.metadata === "object" ? p.metadata : {};
  const attendee = (Array.isArray(p.attendees) && p.attendees[0]) || {};
  const responses = p.responses || p.bookingFieldsResponses || {};
  const respValue = (k) => (responses[k] && typeof responses[k] === "object" ? responses[k].value : responses[k]);

  const meeting =
    [metadata.videoCallUrl, p.videoCallData?.url, p.meetingUrl, p.location].find(isHttp) || null;
  const start = p.startTime || p.start || null;
  const end = p.endTime || p.end || null;
  const oldUid = p.rescheduleUid || p.rescheduledFromUid || p.fromReschedule || null;

  return {
    uid,
    booking_id: Number(p.bookingId || p.id) || null,
    event_type_id: Number(p.eventTypeId || p.eventType?.id) || null,
    start: start ? new Date(start) : null,
    end: end ? new Date(end) : null,
    email: (attendee.email || respValue("email") || "").trim().toLowerCase() || null,
    name: (attendee.name || respValue("name") || "").trim() || null,
    meeting_url: meeting,
    ig_user_id: metadata.ig_user_id ? String(metadata.ig_user_id) : null,
    ig: metadata.ig ? String(metadata.ig).replace(/^@/, "") : null,
    old_uid: oldUid && oldUid !== uid ? oldUid : null,
    status: p.status ? String(p.status).toLowerCase() : null,
    no_show: Array.isArray(p.attendees) ? p.attendees.some((a) => a.noShow || a.absent) : false,
  };
}

// ─── lead matching ──────────────────────────────────────────────────────────

async function findLead(accountId, b, resolveContact) {
  if (b.ig_user_id) {
    const lead = await resolveContact(accountId, b.ig_user_id);
    if (lead) return { lead, matched_by: "ig_user_id" };
  }
  if (b.ig) {
    const lead = await resolveContact(accountId, `@${b.ig}`);
    if (lead) return { lead, matched_by: "ig" };
  }
  if (b.email) {
    const re = new RegExp(`^${escapeRegex(b.email)}$`, "i");
    const lead = await Lead.findOne({ account_id: accountId, $or: [{ email: re }, { emails: re }] }).sort({ _id: -1 });
    if (lead) return { lead, matched_by: "email" };
  }
  return { lead: null, matched_by: null };
}

async function createLeadFor(accountId, b) {
  const [first, ...rest] = (b.name || "").split(/\s+/).filter(Boolean);
  return Lead.create({
    account_id: accountId,
    first_name: first || null,
    last_name: rest.join(" ") || null,
    email: b.email,
    emails: b.email ? [b.email] : [],
    ig_username: b.ig || null,
    ig_user_id: b.ig_user_id || null,
    source: "calcom",
    source_type: "other",
    source_label: "Cal.com booking",
    date_created: new Date().toISOString(),
  });
}

// ─── stage changes ──────────────────────────────────────────────────────────

function markBooked(lead, at, applyStageDates) {
  if (lead.stage !== "booked") {
    lead.stage_history = [...(lead.stage_history || []), { from: lead.stage || "new", to: "booked", at: new Date(), by: "calcom" }];
    lead.stage = "booked";
  }
  applyStageDates(lead, "booked", at);
}

// Back to whatever stage the lead was in before the call was booked.
async function unbookIfNoOtherCall(lead, accountObjectId) {
  const other = await Booking.exists({
    account_id: accountObjectId,
    lead_id: lead._id,
    status: "scheduled",
    booking_date: { $gte: new Date() },
  });
  if (other || lead.stage !== "booked") return;
  const before = [...(lead.stage_history || [])].reverse().find((h) => h.to === "booked")?.from;
  const to = before && before !== "booked" ? before : "negotiating";
  lead.stage_history = [...(lead.stage_history || []), { from: "booked", to, at: new Date(), by: "calcom" }];
  lead.stage = to;
  lead.booked_at = null;
}

// ─── main handler ───────────────────────────────────────────────────────────

/**
 * Apply one Cal.com event to the CRM. Used by the webhook and by the backfill.
 * `deps` = { resolveContact, applyStageDates } from routes/agent.js (passed in to avoid a cycle).
 * Returns { action, booking_id?, lead_id?, matched_by? }.
 */
async function handleCalcomEvent(account, triggerEvent, rawPayload, deps, { notify = true } = {}) {
  const trigger = String(triggerEvent || "").toUpperCase();
  if (!TRIGGERS.includes(trigger)) return { action: "ignored", reason: "trigger" };

  const b = normalizeBooking(rawPayload);
  if (!b) return { action: "ignored", reason: "no_uid" };

  const ids = account.calcom?.event_type_ids || [];
  if (ids.length && b.event_type_id && !ids.includes(b.event_type_id)) return { action: "ignored", reason: "event_type" };

  const accountObjectId = account._id;
  const accountId = String(account._id);
  const existing = await Booking.findOne({ calcom_uid: b.uid });

  if (trigger === "BOOKING_CANCELLED") {
    if (!existing) return { action: "ignored", reason: "unknown_booking" };
    if (existing.status === "cancelled") return { action: "noop", booking_id: String(existing._id) };
    existing.status = "cancelled";
    existing.cancelled_at = new Date();
    await existing.save();
    if (existing.lead_id) {
      const lead = await Lead.findById(existing.lead_id);
      if (lead) {
        await unbookIfNoOtherCall(lead, accountObjectId);
        await lead.save();
      }
    }
    return { action: "cancelled", booking_id: String(existing._id), lead_id: existing.lead_id ? String(existing.lead_id) : null };
  }

  if (trigger === "BOOKING_NO_SHOW_UPDATED") {
    if (!existing) return { action: "ignored", reason: "unknown_booking" };
    const next = b.no_show || rawPayload?.noShow ? "no_show" : existing.status === "no_show" ? "scheduled" : existing.status;
    if (next === existing.status) return { action: "noop", booking_id: String(existing._id) };
    existing.status = next;
    await existing.save();
    return { action: next, booking_id: String(existing._id) };
  }

  // CREATED or RESCHEDULED
  if (existing && existing.status === "scheduled" && trigger === "BOOKING_CREATED") {
    return { action: "noop", booking_id: String(existing._id) };
  }

  let previous = null;
  if (trigger === "BOOKING_RESCHEDULED" && b.old_uid) {
    previous = await Booking.findOne({ calcom_uid: b.old_uid });
    if (previous && previous.status !== "cancelled") {
      previous.status = "cancelled";
      previous.cancelled_at = new Date();
      previous.notes = [previous.notes, "Rescheduled"].filter(Boolean).join(" · ");
      await previous.save();
    }
  }

  let lead = null;
  let matched_by = null;
  if (previous?.lead_id) {
    lead = await Lead.findById(previous.lead_id);
    matched_by = lead ? "reschedule" : null;
  }
  if (!lead && existing?.lead_id) {
    lead = await Lead.findById(existing.lead_id);
    matched_by = lead ? "booking" : null;
  }
  if (!lead) ({ lead, matched_by } = await findLead(accountId, b, deps.resolveContact));
  let created = false;
  if (!lead) {
    lead = await createLeadFor(accountId, b);
    created = true;
    matched_by = "created";
  }

  if (b.email && !lead.email) lead.email = b.email;
  if (b.email && !(lead.emails || []).includes(b.email)) lead.emails = [...(lead.emails || []), b.email];
  markBooked(lead, new Date(), deps.applyStageDates);
  await lead.save();

  const fields = {
    account_id: accountObjectId,
    lead_id: lead._id,
    source: "inbound",
    provider: "calcom",
    contact_name: b.name || [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "",
    ig_username: lead.ig_username || null,
    email: b.email || lead.email || null,
    booking_date: b.start || new Date(),
    end_date: b.end,
    status: "scheduled",
    calcom_booking_id: b.booking_id,
    calcom_event_type_id: b.event_type_id,
    meeting_url: b.meeting_url,
    rescheduled_from_uid: previous ? previous.calcom_uid : b.old_uid,
    cancelled_at: null,
  };
  const booking = await Booking.findOneAndUpdate(
    { calcom_uid: b.uid },
    { $set: fields, $setOnInsert: { calcom_uid: b.uid } },
    { upsert: true, new: true },
  );

  if (notify && trigger === "BOOKING_CREATED") {
    notifyNewLead(account, lead).catch((err) => logger.error({ err }, "Telegram notify error"));
  }

  return {
    action: trigger === "BOOKING_RESCHEDULED" ? "rescheduled" : "booked",
    booking_id: String(booking._id),
    lead_id: String(lead._id),
    matched_by,
    created_lead: created,
  };
}

/** A v2 API booking (backfill) → the trigger it corresponds to. */
function triggerForApiBooking(apiBooking) {
  const s = String(apiBooking?.status || "").toLowerCase();
  if (s === "cancelled" || s === "rejected") return "BOOKING_CANCELLED";
  return "BOOKING_CREATED";
}

module.exports = {
  TRIGGERS,
  verifyCalcomSignature,
  normalizeBooking,
  handleCalcomEvent,
  triggerForApiBooking,
};

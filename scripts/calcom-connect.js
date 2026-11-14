/**
 * Connect a Cal.com event type to the CRM.
 *
 *   CALCOM_KEY=... railway run node scripts/calcom-connect.js --account <AccountId> [--event 7876697] [--apply] [--backfill]
 *
 * Default (no flags): READ-ONLY. Lists the webhooks already on that event type and
 * what the account has stored. Writes nothing anywhere.
 *
 * --apply     Creates ONE webhook on that event type only (never an account-wide one,
 *             never touches existing webhooks), with a fresh secret, pointing at
 *             PUBLIC_SERVER_URL/calcom-webhook/<accountId>. Saves the webhook id, the
 *             encrypted secret, the event type and its booking URL on the Account.
 *             Re-running it while connected reuses the stored webhook.
 * --backfill  Replays the event type's existing bookings through the same handler the
 *             webhook uses (no HTTP). Safe to repeat: bookings are keyed by uid.
 *
 * Run under `railway run` so MONGO_URI, ENCRYPTION_KEY and PUBLIC_SERVER_URL come from
 * production; without ENCRYPTION_KEY the secret would be stored in plaintext.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const Account = require("../models/Account");
const { encrypt } = require("../utils/crypto");
const { handleCalcomEvent, triggerForApiBooking } = require("../services/calcomBooking");
const { resolveContact, applyStageDates } = require("../routes/agent");

const API = "https://api.cal.com/v2";
const TRIGGERS = ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED", "BOOKING_NO_SHOW_UPDATED"];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

async function cal(path, { method = "GET", body, version = "2024-06-14" } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.CALCOM_KEY}`,
      "cal-api-version": version,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Cal.com ${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function main() {
  const accountId = opt("--account");
  const eventTypeId = Number(opt("--event", "7876697"));
  if (!mongoose.isValidObjectId(accountId)) throw new Error("--account <AccountId> required");
  if (!process.env.CALCOM_KEY) throw new Error("CALCOM_KEY env required");
  if (!process.env.PUBLIC_SERVER_URL) throw new Error("PUBLIC_SERVER_URL env required");

  await mongoose.connect(process.env.MONGO_URI);
  const account = await Account.findById(accountId);
  if (!account) throw new Error("account not found");

  const subscriberUrl = new URL(`/calcom-webhook/${accountId}`, process.env.PUBLIC_SERVER_URL).toString();
  const event = (await cal(`/event-types/${eventTypeId}`)).data;
  const bookingUrl = event?.bookingUrl;
  const hooks = (await cal(`/event-types/${eventTypeId}/webhooks`)).data || [];

  console.log(`event ${eventTypeId} "${event?.title}" ${bookingUrl}`);
  console.log(`webhooks on this event: ${hooks.length}`);
  for (const h of hooks) console.log(`  ${h.id} ${h.subscriberUrl} active=${h.active} ${JSON.stringify(h.triggers)}`);
  console.log(`account calcom: enabled=${!!account.calcom?.enabled} webhook_id=${account.calcom?.webhook_id || "-"} events=${JSON.stringify(account.calcom?.event_type_ids || [])}`);
  console.log(`target: ${subscriberUrl}`);

  if (flag("--apply")) {
    const mine = hooks.find((h) => h.subscriberUrl === subscriberUrl);
    let webhookId = mine?.id;
    let secret = null;
    if (mine && account.calcom?.webhook_id === String(mine.id) && account.calcom?.webhook_secret) {
      console.log(`already connected (webhook ${mine.id}), keeping it`);
    } else {
      secret = crypto.randomBytes(32).toString("hex");
      if (mine) {
        await cal(`/event-types/${eventTypeId}/webhooks/${mine.id}`, {
          method: "PATCH",
          body: { subscriberUrl, triggers: TRIGGERS, active: true, secret },
        });
        console.log(`updated webhook ${mine.id} with a new secret`);
      } else {
        const created = await cal(`/event-types/${eventTypeId}/webhooks`, {
          method: "POST",
          body: { subscriberUrl, triggers: TRIGGERS, active: true, secret },
        });
        webhookId = created.data?.id;
        console.log(`created webhook ${webhookId}`);
      }
    }
    const set = {
      "calcom.webhook_id": String(webhookId),
      "calcom.event_type_ids": [...new Set([...(account.calcom?.event_type_ids || []), eventTypeId])],
      "calcom.booking_url": bookingUrl,
      "calcom.enabled": true,
      "calcom.connected_at": account.calcom?.connected_at || new Date(),
    };
    if (secret) set["calcom.webhook_secret"] = encrypt(secret);
    await Account.updateOne({ _id: account._id }, { $set: set });
    console.log("account saved");
  }

  if (flag("--backfill")) {
    const fresh = await Account.findById(accountId).lean();
    if (!fresh.calcom?.event_type_ids?.includes(eventTypeId)) throw new Error("connect first (--apply)");
    const bookings = (await cal(`/bookings?eventTypeId=${eventTypeId}&take=100`, { version: "2024-08-13" })).data || [];
    const tally = {};
    for (const b of bookings) {
      const r = await handleCalcomEvent(fresh, triggerForApiBooking(b), b, { resolveContact, applyStageDates }, { notify: false });
      tally[r.action] = (tally[r.action] || 0) + 1;
      console.log(`  ${b.uid.slice(0, 8)} ${b.status} ${b.start} → ${r.action}${r.matched_by ? ` (${r.matched_by})` : ""}`);
    }
    console.log(`backfill: ${bookings.length} bookings ${JSON.stringify(tally)}`);
  }

  if (!flag("--apply") && !flag("--backfill")) console.log("(read-only: nothing written)");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

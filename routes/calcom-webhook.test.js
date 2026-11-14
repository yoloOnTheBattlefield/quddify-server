const express = require("express");
const mongoose = require("mongoose");
const { createHmac } = require("crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

jest.mock("../services/telegramNotifier", () => ({ notifyNewLead: jest.fn().mockResolvedValue(undefined) }));

const Account = require("../models/Account");
const Lead = require("../models/Lead");
const Booking = require("../models/Booking");
const { notifyNewLead } = require("../services/telegramNotifier");
const { normalizeBooking, handleCalcomEvent, triggerForApiBooking } = require("../services/calcomBooking");
const { resolveContact, applyStageDates } = require("./agent");
const calcomWebhookRouter = require("./calcom-webhook");

const SECRET = "c".repeat(64);
const EVENT = 7876697;
const IG = "1456618667530017";

let mongoServer;
let app;
let accountId;

const sign = (raw, secret = SECRET) => createHmac("sha256", secret).update(raw).digest("hex");

function payload(over = {}) {
  return {
    uid: "uid_1",
    bookingId: 101,
    eventTypeId: EVENT,
    startTime: new Date(Date.now() + 2 * 86400000).toISOString(),
    endTime: new Date(Date.now() + 2 * 86400000 + 1800000).toISOString(),
    attendees: [{ email: "Amine@Example.com", name: "Amine Biz", timeZone: "Europe/Paris" }],
    metadata: { videoCallUrl: "https://meet.google.com/abc-defg-hij", ig_user_id: IG, ig: "amine_biz" },
    ...over,
  };
}

async function post(triggerEvent, p, { signature, id } = {}) {
  const raw = JSON.stringify({ triggerEvent, createdAt: new Date().toISOString(), payload: p });
  const req = request(app).post(`/calcom-webhook/${id || accountId}`).set("Content-Type", "application/json");
  const sig = signature !== undefined ? signature : sign(raw);
  if (sig !== null) req.set("x-cal-signature-256", sig);
  return req.send(raw);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Booking.syncIndexes();
  app = express();
  app.use(
    "/calcom-webhook",
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
    calcomWebhookRouter,
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await Promise.all([Account.deleteMany({}), Lead.deleteMany({}), Booking.deleteMany({})]);
  const account = await Account.create({
    name: "Me",
    calcom: { enabled: true, webhook_secret: SECRET, event_type_ids: [EVENT], booking_url: "https://cal.com/me/ig" },
  });
  accountId = String(account._id);
});

const makeLead = (extra = {}) =>
  Lead.create({ account_id: accountId, ig_username: "amine_biz", ig_user_id: IG, stage: "pitched", ...extra });

describe("signature and routing", () => {
  it("rejects a bad signature", async () => {
    const res = await post("BOOKING_CREATED", payload(), { signature: "00".repeat(32) });
    expect(res.status).toBe(401);
    expect(await Booking.countDocuments()).toBe(0);
  });

  it("rejects a missing signature", async () => {
    const res = await post("BOOKING_CREATED", payload(), { signature: null });
    expect(res.status).toBe(401);
  });

  it("404s an account without a Cal.com connection", async () => {
    const other = await Account.create({ name: "Other" });
    const res = await post("BOOKING_CREATED", payload(), { id: String(other._id) });
    expect(res.status).toBe(404);
  });

  it("answers a ping", async () => {
    const res = await post("PING", {});
    expect(res.status).toBe(200);
  });

  it("ignores other event types", async () => {
    await makeLead();
    const res = await post("BOOKING_CREATED", payload({ eventTypeId: 999 }));
    expect(res.status).toBe(200);
    expect(res.body.action).toBe("ignored");
    expect(await Booking.countDocuments()).toBe(0);
  });
});

describe("BOOKING_CREATED", () => {
  it("matches by the IG id in the link metadata and books the lead", async () => {
    const lead = await makeLead();
    const res = await post("BOOKING_CREATED", payload());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: "booked", matched_by: "ig_user_id", lead_id: String(lead._id) });

    const b = await Booking.findOne({ calcom_uid: "uid_1" }).lean();
    expect(b).toMatchObject({ provider: "calcom", status: "scheduled", calcom_booking_id: 101, calcom_event_type_id: EVENT });
    expect(b.meeting_url).toBe("https://meet.google.com/abc-defg-hij");
    expect(String(b.lead_id)).toBe(String(lead._id));
    expect(String(b.account_id)).toBe(accountId);

    const l = await Lead.findById(lead._id).lean();
    expect(l.stage).toBe("booked");
    expect(l.booked_at).toBeTruthy();
    expect(l.email).toBe("amine@example.com");
    expect(l.stage_history.at(-1)).toMatchObject({ from: "pitched", to: "booked", by: "calcom" });
    expect(notifyNewLead).toHaveBeenCalledTimes(1);
  });

  it("matches on the Instagram handle answered in the booking form", async () => {
    const lead = await makeLead({ ig_user_id: "555", ig_username: "Real_Handle", email: null });
    const res = await post("BOOKING_CREATED", payload({ metadata: {}, responses: { instagram: { value: " @real_handle " }, email: "x@y.co" } }));
    expect(res.body).toMatchObject({ action: "booked", lead_id: String(lead._id) });
  });

  it("accepts a full profile URL as the handle answer", async () => {
    const lead = await makeLead({ ig_user_id: "556", ig_username: "url_person", email: null });
    const res = await post("BOOKING_CREATED", payload({ metadata: {}, responses: { instagram: "https://www.instagram.com/URL_Person/?hl=en" } }));
    expect(res.body).toMatchObject({ action: "booked", lead_id: String(lead._id) });
  });

  it("falls back to the attendee email", async () => {
    const lead = await makeLead({ ig_user_id: "555", ig_username: "someone_else", email: "amine@example.com" });
    const res = await post("BOOKING_CREATED", payload({ metadata: {} }));
    expect(res.body).toMatchObject({ action: "booked", matched_by: "email", lead_id: String(lead._id) });
  });

  it("creates a contact when nobody matches", async () => {
    const res = await post("BOOKING_CREATED", payload({ metadata: {} }));
    expect(res.body).toMatchObject({ action: "booked", matched_by: "created", created_lead: true });
    const l = await Lead.findById(res.body.lead_id).lean();
    expect(l).toMatchObject({ source: "calcom", stage: "booked", email: "amine@example.com", first_name: "Amine" });
    expect(l.account_id).toBe(accountId);
  });

  it("is idempotent on a repeat delivery", async () => {
    await makeLead();
    await post("BOOKING_CREATED", payload());
    const again = await post("BOOKING_CREATED", payload());
    expect(again.body.action).toBe("noop");
    expect(await Booking.countDocuments()).toBe(1);
    expect(notifyNewLead).toHaveBeenCalledTimes(1);
  });
});

describe("reschedule, cancel, no-show", () => {
  it("reschedule cancels the old booking and keeps the lead booked", async () => {
    const lead = await makeLead();
    await post("BOOKING_CREATED", payload());
    const later = new Date(Date.now() + 5 * 86400000).toISOString();
    const res = await post("BOOKING_RESCHEDULED", payload({ uid: "uid_2", bookingId: 102, rescheduleUid: "uid_1", startTime: later, metadata: {} }));
    expect(res.body).toMatchObject({ action: "rescheduled", matched_by: "reschedule", lead_id: String(lead._id) });

    const old = await Booking.findOne({ calcom_uid: "uid_1" }).lean();
    const fresh = await Booking.findOne({ calcom_uid: "uid_2" }).lean();
    expect(old.status).toBe("cancelled");
    expect(fresh).toMatchObject({ status: "scheduled", rescheduled_from_uid: "uid_1" });
    expect(new Date(fresh.booking_date).toISOString()).toBe(later);
    expect((await Lead.findById(lead._id).lean()).stage).toBe("booked");
  });

  it("cancel reverts the lead to its stage before booking", async () => {
    const lead = await makeLead();
    await post("BOOKING_CREATED", payload());
    const res = await post("BOOKING_CANCELLED", payload());
    expect(res.body.action).toBe("cancelled");
    expect((await Booking.findOne({ calcom_uid: "uid_1" }).lean()).status).toBe("cancelled");
    const l = await Lead.findById(lead._id).lean();
    expect(l.stage).toBe("pitched");
    expect(l.booked_at).toBeFalsy();

    const repeat = await post("BOOKING_CANCELLED", payload());
    expect(repeat.body.action).toBe("noop");
  });

  it("cancel keeps the lead booked while another call is scheduled", async () => {
    const lead = await makeLead();
    await post("BOOKING_CREATED", payload());
    await post("BOOKING_CREATED", payload({ uid: "uid_3", bookingId: 103 }));
    await post("BOOKING_CANCELLED", payload());
    expect((await Lead.findById(lead._id).lean()).stage).toBe("booked");
  });

  it("no-show marks the booking", async () => {
    await makeLead();
    await post("BOOKING_CREATED", payload());
    const p = payload();
    p.attendees[0].noShow = true;
    const res = await post("BOOKING_NO_SHOW_UPDATED", p);
    expect(res.body.action).toBe("no_show");
    expect((await Booking.findOne({ calcom_uid: "uid_1" }).lean()).status).toBe("no_show");
  });

  it("cancel for an unknown booking is ignored", async () => {
    const res = await post("BOOKING_CANCELLED", payload({ uid: "nope" }));
    expect(res.body.action).toBe("ignored");
  });
});

describe("backfill path (API booking shape)", () => {
  it("normalizes a v2 API booking and books through the same handler", async () => {
    const lead = await makeLead({ email: "amine@example.com", ig_user_id: "999" });
    const apiBooking = {
      id: 28728956,
      uid: "8LmLtmX6",
      status: "accepted",
      start: new Date(Date.now() + 86400000).toISOString(),
      end: new Date(Date.now() + 86400000 + 1800000).toISOString(),
      eventTypeId: EVENT,
      eventType: { id: EVENT, slug: "ig" },
      meetingUrl: "https://meet.google.com/dph-ggos-dff",
      attendees: [{ name: "Amine", email: "amine@example.com", absent: false }],
      metadata: {},
    };
    const b = normalizeBooking(apiBooking);
    expect(b).toMatchObject({ uid: "8LmLtmX6", booking_id: 28728956, event_type_id: EVENT, meeting_url: "https://meet.google.com/dph-ggos-dff" });
    expect(triggerForApiBooking(apiBooking)).toBe("BOOKING_CREATED");
    expect(triggerForApiBooking({ status: "cancelled" })).toBe("BOOKING_CANCELLED");

    const account = await Account.findById(accountId).lean();
    const r = await handleCalcomEvent(account, "BOOKING_CREATED", apiBooking, { resolveContact, applyStageDates }, { notify: false });
    expect(r).toMatchObject({ action: "booked", matched_by: "email", lead_id: String(lead._id) });
    expect(notifyNewLead).not.toHaveBeenCalled();
  });
});

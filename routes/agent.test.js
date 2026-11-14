const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Account = require("../models/Account");
const Lead = require("../models/Lead");
const IgConversation = require("../models/IgConversation");
const IgMessage = require("../models/IgMessage");
const AgentLock = require("../models/AgentLock");
const MediaInsight = require("../models/MediaInsight");
const agentRouter = require("./agent");

let mongoServer;
let app;
const accountId = new mongoose.Types.ObjectId();
const otherAccountId = new mongoose.Types.ObjectId();
const OWNER_IG = "28171862109129402";
const CONTACT_IG = "1456618667530017";
const CONV_ID = "6af8aa11bb22cc33dd44ee0f";

function appFor(id) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.account = { _id: id };
    next();
  });
  a.use("/api/agent", agentRouter);
  return a;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await AgentLock.syncIndexes();
  await IgMessage.syncIndexes();
  await Account.create({ _id: accountId, name: "Me", zernio: { ig_user_id: OWNER_IG } });
  await Account.create({ _id: otherAccountId, name: "Other" });
  app = appFor(accountId);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Promise.all([
    Lead.deleteMany({}), IgConversation.deleteMany({}), IgMessage.deleteMany({}), AgentLock.deleteMany({}), MediaInsight.deleteMany({}),
  ]);
});

async function makeLead(extra = {}) {
  return Lead.create({
    account_id: String(accountId),
    ig_username: "Amine_Biz",
    ig_user_id: CONTACT_IG,
    zernio_conversation_id: CONV_ID,
    ...extra,
  });
}

describe("ref resolution", () => {
  it("finds a contact by Zernio conversation id, IG user id and handle", async () => {
    const lead = await makeLead();
    for (const ref of [CONV_ID, CONTACT_IG, "@amine_biz", "AMINE_BIZ"]) {
      const res = await request(app).get(`/api/agent/contacts/${encodeURIComponent(ref)}`);
      expect(res.status).toBe(200);
      expect(res.body.contact.id).toBe(String(lead._id));
    }
  });

  it("finds a contact through a linked conversation's participant id", async () => {
    const lead = await Lead.create({ account_id: String(accountId), ig_username: "x" });
    await IgConversation.create({
      instagram_thread_id: "t1",
      account_id: accountId,
      lead_id: lead._id,
      participant_ids: [OWNER_IG, "999"],
    });
    const res = await request(app).get("/api/agent/contacts/999");
    expect(res.status).toBe(200);
    expect(res.body.contact.id).toBe(String(lead._id));
  });

  it("never returns another account's contact", async () => {
    await Lead.create({ account_id: String(otherAccountId), ig_username: "amine_biz" });
    const res = await request(app).get("/api/agent/contacts/@amine_biz");
    expect(res.status).toBe(404);
  });
});

describe("PUT/PATCH /contacts/:ref", () => {
  it("creates on first PUT and merges on the second", async () => {
    const first = await request(app)
      .put("/api/agent/contacts/@newlead")
      .send({ industry: "M&A", ticket_size: "fee 5-10%", source: "bonnie_story" });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(first.body.contact.ig_username).toBe("newlead");
    expect(first.body.contact.stage).toBe("new");

    const second = await request(app).put("/api/agent/contacts/@newlead").send({ monthly_revenue_usd: 20000 });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.contact.industry).toBe("M&A");
    expect(second.body.contact.monthly_revenue_usd).toBe(20000);
    expect(await Lead.countDocuments({ ig_username: "newlead" })).toBe(1);
  });

  it("creates by IG user id and links existing conversations", async () => {
    await IgConversation.create({ instagram_thread_id: "t2", account_id: accountId, participant_ids: [OWNER_IG, "777"] });
    const res = await request(app).put("/api/agent/contacts/777").send({ language: "ro" });
    expect(res.status).toBe(201);
    const conv = await IgConversation.findOne({ instagram_thread_id: "t2" });
    expect(String(conv.lead_id)).toBe(res.body.contact.id);
  });

  it("rejects unknown fields with the allowed list", async () => {
    await makeLead();
    const res = await request(app).patch(`/api/agent/contacts/${CONTACT_IG}`).send({ stage: "booked", favourite_color: "red" });
    expect(res.status).toBe(400);
    expect(res.body.unknown_fields).toEqual(["favourite_color"]);
    expect(res.body.allowed_fields).toContain("stage");
  });

  it("records stage history and keeps the funnel dates in step", async () => {
    await makeLead();
    await request(app).patch(`/api/agent/contacts/${CONTACT_IG}`).send({ stage: "pitched", pitch: { offer: "sprint_5k", amount: 5000 } });
    const res = await request(app).patch(`/api/agent/contacts/${CONTACT_IG}`).send({ stage: "booked" });
    expect(res.status).toBe(200);
    expect(res.body.contact.stage).toBe("booked");
    expect(res.body.contact.stage_history.map((h) => h.to)).toEqual(["pitched", "booked"]);
    expect(res.body.contact.booked_at).toBeTruthy();
    expect(res.body.contact.pitch.offer).toBe("sprint_5k");
    expect(res.body.contact.pitch.amount).toBe(5000);
    const lead = await Lead.findOne({ ig_user_id: CONTACT_IG });
    expect(lead.link_sent_at).toBeTruthy();
  });

  it("merges lead_magnet fields without wiping the others", async () => {
    await makeLead();
    await request(app).patch(`/api/agent/contacts/${CONTACT_IG}`).send({ lead_magnet: { status: "posted", brief: "B" } });
    const res = await request(app).patch(`/api/agent/contacts/${CONTACT_IG}`).send({ lead_magnet: { doc_url: "https://d" } });
    expect(res.body.contact.lead_magnet).toMatchObject({ status: "posted", brief: "B", doc_url: "https://d" });
  });

  it("404s a PATCH for an unknown contact", async () => {
    const res = await request(app).patch("/api/agent/contacts/@ghost").send({ stage: "qualifying" });
    expect(res.status).toBe(404);
  });
});

describe("POST /messages", () => {
  it("stores a bot message once, idempotent on zernio_message_id", async () => {
    await makeLead();
    const body = { ref: CONTACT_IG, zernio_message_id: "zm_1", text: "hey", sent_by: "bot" };
    const a = await request(app).post("/api/agent/messages").send(body);
    expect(a.status).toBe(201);
    expect(a.body.stored).toBe(true);
    expect(a.body.contact.last_bot_send_at).toBeTruthy();
    const b = await request(app).post("/api/agent/messages").send(body);
    expect(b.status).toBe(200);
    expect(b.body.duplicate).toBe(true);
    expect(await IgMessage.countDocuments({ zernio_message_id: "zm_1" })).toBe(1);

    const got = await request(app).get(`/api/agent/contacts/${CONTACT_IG}`);
    expect(got.body.messages).toHaveLength(1);
    expect(got.body.messages[0]).toMatchObject({ direction: "outbound", sent_by: "bot", text: "hey" });
  });

  it("a cristian send makes the contact live for 60 minutes", async () => {
    await makeLead();
    const sentAt = new Date().toISOString();
    const res = await request(app)
      .post("/api/agent/messages")
      .send({ ref: CONTACT_IG, zernio_message_id: "zm_2", text: "I'll take it", sent_by: "cristian", sent_at: sentAt });
    expect(res.status).toBe(201);
    expect(res.body.contact.live).toBe(true);
    const until = new Date(res.body.contact.live_until).getTime();
    expect(until - new Date(sentAt).getTime()).toBe(60 * 60 * 1000);
  });

  it("rejects an unknown sent_by", async () => {
    await makeLead();
    const res = await request(app).post("/api/agent/messages").send({ ref: CONTACT_IG, zernio_message_id: "z", text: "x", sent_by: "lead" });
    expect(res.status).toBe(400);
  });
});

describe("GET /events", () => {
  it("returns messages and stage changes since a time", async () => {
    await makeLead();
    const since = new Date(Date.now() - 1000).toISOString();
    await request(app).post("/api/agent/messages").send({ ref: CONTACT_IG, zernio_message_id: "zm_e", text: "hi", sent_by: "bot" });
    await request(app).patch(`/api/agent/contacts/${CONTACT_IG}`).send({ stage: "qualifying" });
    const res = await request(app).get(`/api/agent/events?ref=${CONTACT_IG}&since=${encodeURIComponent(since)}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.stage_changes).toHaveLength(1);
  });
});

describe("locks", () => {
  it("lets one run in, 409s the second, and frees after release or expiry", async () => {
    await makeLead();
    const a = await request(app).post(`/api/agent/locks/${CONTACT_IG}`).send({ run_id: "run-a" });
    expect(a.status).toBe(200);
    expect(a.body.acquired).toBe(true);

    const b = await request(app).post(`/api/agent/locks/${CONTACT_IG}`).send({ run_id: "run-b" });
    expect(b.status).toBe(409);
    expect(b.body.held_by).toBe("run-a");

    const again = await request(app).post(`/api/agent/locks/${CONTACT_IG}`).send({ run_id: "run-a" });
    expect(again.status).toBe(200);

    const wrongRelease = await request(app).delete(`/api/agent/locks/${CONTACT_IG}?run_id=run-b`);
    expect(wrongRelease.body.released).toBe(false);
    const release = await request(app).delete(`/api/agent/locks/${CONTACT_IG}`).send({ run_id: "run-a" });
    expect(release.body.released).toBe(true);

    const c = await request(app).post(`/api/agent/locks/${CONTACT_IG}`).send({ run_id: "run-c" });
    expect(c.status).toBe(200);
    await AgentLock.updateOne({}, { $set: { expires_at: new Date(Date.now() - 1000) } });
    const d = await request(app).post(`/api/agent/locks/${CONTACT_IG}`).send({ run_id: "run-d" });
    expect(d.status).toBe(200);
    expect(d.body.run_id).toBe("run-d");
  });
});

describe("follow-ups, skips, lead magnets, stats", () => {
  it("lists quiet contacts in the given stages, oldest first, skips excluded", async () => {
    const old = new Date(Date.now() - 5 * 86400000);
    const older = new Date(Date.now() - 9 * 86400000);
    await Lead.create([
      { account_id: String(accountId), ig_username: "a", stage: "pitched", last_inbound_at: old },
      { account_id: String(accountId), ig_username: "b", stage: "qualifying", last_inbound_at: older },
      { account_id: String(accountId), ig_username: "c", stage: "pitched", last_inbound_at: new Date() },
      { account_id: String(accountId), ig_username: "d", stage: "pitched", last_inbound_at: older, skip: true },
      { account_id: String(accountId), ig_username: "e", stage: "booked", last_inbound_at: older },
    ]);
    const res = await request(app).get("/api/agent/followups?days=3&stages=qualifying,pitched");
    expect(res.status).toBe(200);
    expect(res.body.contacts.map((c) => c.ig_username)).toEqual(["b", "a"]);

    const bad = await request(app).get("/api/agent/followups?stages=nope");
    expect(bad.status).toBe(400);
  });

  it("skips by handle, creating unknown contacts, and lists them", async () => {
    await makeLead();
    const res = await request(app).post("/api/agent/skips").send({ refs: [CONTACT_IG, "@friend_hayk"], reason: "friends" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 1, created: 1 });
    const list = await request(app).get("/api/agent/skips");
    expect(list.body.skips.map((s) => s.ig_username).sort()).toEqual(["Amine_Biz", "friend_hayk"]);
    expect(list.body.skips[0].skip_reason).toBe("friends");
  });

  it("lists the lead magnet build queue and the stats", async () => {
    await Lead.create([
      { account_id: String(accountId), ig_username: "a", stage: "qualifying", lead_magnet: { status: "posted", brief: "x" } },
      { account_id: String(accountId), ig_username: "b", stage: "pitched", lead_magnet: { status: "sent" } },
      { account_id: String(accountId), ig_username: "c" },
      { account_id: String(accountId), ig_username: "d", skip: true, stage: "pitched" },
    ]);
    await Lead.collection.insertOne({ account_id: String(accountId), ig_username: "legacy" }); // no stage field

    const q = await request(app).get("/api/agent/lead-magnets");
    expect(q.body.contacts.map((c) => c.ig_username)).toEqual(["a"]);

    const s = await request(app).get("/api/agent/stats");
    expect(s.status).toBe(200);
    expect(s.body.stages).toMatchObject({ new: 2, qualifying: 1, pitched: 1, booked: 0 });
    expect(s.body.total).toBe(4);
    expect(s.body.skipped).toBe(1);
    expect(s.body.lead_magnets).toEqual({ posted: 1, building: 0, built: 0, sent: 1 });
  });
});

describe("lead source", () => {
  it("accepts the source fields and resolves a reel URL to its media id", async () => {
    await MediaInsight.create({
      account_id: accountId, ig_user_id: OWNER_IG, media_id: "18136828201622965",
      permalink: "https://www.instagram.com/reel/DdHIlYTANWd/", posted_at: new Date(),
    });
    await MediaInsight.create({
      account_id: otherAccountId, ig_user_id: "x", media_id: "other_media",
      permalink: "https://www.instagram.com/reel/OTHER1/", posted_at: new Date(),
    });
    await makeLead();

    const res = await request(app)
      .patch(`/api/agent/contacts/${CONTACT_IG}`)
      .send({ source_type: "reel", source_label: "System reel", source_url: "https://instagram.com/cristiandealflow/reel/DdHIlYTANWd/?igsh=abc" });

    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({
      source_type: "reel",
      source_label: "System reel",
      source_media_id: "18136828201622965",
      source_url: "https://instagram.com/cristiandealflow/reel/DdHIlYTANWd/?igsh=abc",
    });

    // another account's post is never matched
    const other = await request(app).put("/api/agent/contacts/@someone").send({ source_url: "https://www.instagram.com/reel/OTHER1/" });
    expect(other.body.contact.source_media_id).toBeNull();
  });

  it("keeps an explicit source_media_id and rejects an unknown source_type", async () => {
    await makeLead();
    const ok = await request(app)
      .put(`/api/agent/contacts/${CONTACT_IG}`)
      .send({ source_type: "story", source_label: "Bonnie story", source_media_id: "story_1" });
    expect(ok.body.contact).toMatchObject({ source_type: "story", source_media_id: "story_1" });

    const bad = await request(app).patch(`/api/agent/contacts/${CONTACT_IG}`).send({ source_type: "billboard" });
    expect(bad.status).toBe(400);
  });
});

describe("dashboard funnel stays in step with stage and thread", () => {
  it("a stage past new sets messaged_at and replied_at; pitched also sets link_sent_at", async () => {
    await makeLead();
    const q = await request(app).patch(`/api/agent/contacts/${CONTACT_IG}`).send({ stage: "qualifying" });
    expect(q.status).toBe(200);
    let lead = await Lead.findOne({ ig_user_id: CONTACT_IG }).lean();
    expect(lead.messaged_at).toBeTruthy();
    expect(lead.replied_at).toBeTruthy();
    expect(lead.link_sent_at).toBeFalsy();
    await request(app).patch(`/api/agent/contacts/${CONTACT_IG}`).send({ stage: "pitched" });
    lead = await Lead.findOne({ ig_user_id: CONTACT_IG }).lean();
    expect(lead.link_sent_at).toBeTruthy();
    expect(lead.booked_at).toBeFalsy();
  });

  it("new and lost do not invent replies", async () => {
    await makeLead({ stage: "qualifying" });
    await request(app).patch(`/api/agent/contacts/${CONTACT_IG}`).send({ stage: "lost" });
    const lead = await Lead.findOne({ ig_user_id: CONTACT_IG }).lean();
    expect(lead.disqualified_at).toBeTruthy();
    expect(lead.replied_at).toBeFalsy();
  });

  it("linking a migrated contact dates it from its first inbound message", async () => {
    const conv = await IgConversation.create({
      instagram_thread_id: `${CONTACT_IG}_${OWNER_IG}`, account_id: accountId, participant_ids: [CONTACT_IG, OWNER_IG],
    });
    const first = new Date("2026-11-02T10:00:00Z");
    const last = new Date("2026-11-10T09:00:00Z");
    for (const [i, t] of [first, last].entries()) {
      await IgMessage.create({
        conversation_id: conv._id, account_id: accountId, direction: "inbound", sender_id: CONTACT_IG,
        recipient_id: OWNER_IG, message_text: "hi", message_id: `m${i}`, timestamp: t,
      });
    }
    const res = await request(app).put(`/api/agent/contacts/${CONTACT_IG}`).send({ ig_username: "amine_biz" });
    expect([200, 201]).toContain(res.status);
    const lead = await Lead.findOne({ ig_user_id: CONTACT_IG }).lean();
    expect(new Date(lead.first_conversation_at).toISOString()).toBe(first.toISOString());
    expect(new Date(lead.last_inbound_at).toISOString()).toBe(last.toISOString());
    expect(lead.date_created).toBe(first.toISOString());
    const linked = await IgConversation.findById(conv._id).lean();
    expect(String(linked.lead_id)).toBe(String(lead._id));
  });
});

describe("GET /booking-link/:ref and next_booking", () => {
  const Booking = require("../models/Booking");
  afterEach(async () => {
    await Booking.deleteMany({});
    await Account.updateOne({ _id: accountId }, { $unset: { calcom: 1 } });
  });

  it("409s until Cal.com is connected", async () => {
    await makeLead();
    const res = await request(app).get(`/api/agent/booking-link/${CONTACT_IG}`);
    expect(res.status).toBe(409);
  });

  it("returns the plain booking link", async () => {
    await Account.updateOne({ _id: accountId }, { $set: { calcom: { enabled: true, booking_url: "https://cal.com/me/ig", event_type_ids: [1] } } });
    await makeLead({ first_name: "Amine", last_name: "Biz", email: "a@b.co" });
    const res = await request(app).get(`/api/agent/booking-link/@amine_biz`);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://cal.com/me/ig");
    expect(res.body.booking_url).toBe("https://cal.com/me/ig");
    expect(res.body.next_booking).toBeNull();
  });

  it("contact payload carries the next scheduled call", async () => {
    const lead = await makeLead();
    const soon = new Date(Date.now() + 86400000);
    await Booking.create({ account_id: accountId, lead_id: lead._id, booking_date: new Date(Date.now() - 86400000), status: "scheduled" });
    await Booking.create({ account_id: accountId, lead_id: lead._id, booking_date: soon, status: "scheduled", meeting_url: "https://meet.google.com/x", provider: "calcom", calcom_uid: "u1" });
    const res = await request(app).get(`/api/agent/contacts/${CONTACT_IG}`);
    expect(res.body.next_booking).toMatchObject({ status: "scheduled", meeting_url: "https://meet.google.com/x", uid: "u1" });
    expect(new Date(res.body.next_booking.start).toISOString()).toBe(soon.toISOString());

    const ev = await request(app).get(`/api/agent/events?ref=${CONTACT_IG}&since=${new Date(Date.now() - 60000).toISOString()}`);
    expect(ev.body.bookings).toHaveLength(2);
  });
});

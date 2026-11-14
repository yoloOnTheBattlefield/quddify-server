const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Account = require("../models/Account");
const Lead = require("../models/Lead");
const IgConversation = require("../models/IgConversation");
const IgMessage = require("../models/IgMessage");
const AgentLock = require("../models/AgentLock");
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
  await Promise.all([Lead.deleteMany({}), IgConversation.deleteMany({}), IgMessage.deleteMany({}), AgentLock.deleteMany({})]);
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

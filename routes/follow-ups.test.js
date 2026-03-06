const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const FollowUp = require("../models/FollowUp");
const OutboundLead = require("../models/OutboundLead");
const CampaignLead = require("../models/CampaignLead");
const SenderAccount = require("../models/SenderAccount");

const followUpsRouter = require("./follow-ups");

let mongoServer;
let app;
const accountId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = { _id: accountId };
    next();
  });
  app.use("/api/follow-ups", followUpsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await FollowUp.deleteMany({});
  await OutboundLead.deleteMany({});
  await CampaignLead.deleteMany({});
  await SenderAccount.deleteMany({});
});

function createLead(overrides = {}) {
  const username = overrides.username || "lead_" + Math.random().toString(36).slice(2, 8);
  return OutboundLead.create({
    account_id: accountId,
    followingKey: username,
    username,
    ...overrides,
  });
}

describe("GET /api/follow-ups", () => {
  it("returns empty list when no follow-ups exist", async () => {
    const res = await request(app).get("/api/follow-ups");
    expect(res.status).toBe(200);
    expect(res.body.followUps).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("returns follow-ups with joined lead data", async () => {
    const lead = await createLead({
      username: "testlead",
      fullName: "Test Lead",
      followersCount: 1000,
    });

    await FollowUp.create({
      outbound_lead_id: lead._id,
      account_id: accountId,
      status: "new",
    });

    const res = await request(app).get("/api/follow-ups");
    expect(res.status).toBe(200);
    expect(res.body.followUps).toHaveLength(1);
    expect(res.body.followUps[0].lead.username).toBe("testlead");
  });

  it("filters by status", async () => {
    const lead = await createLead({ username: "lead1" });

    await FollowUp.create({
      outbound_lead_id: lead._id,
      account_id: accountId,
      status: "interested",
    });

    const res = await request(app).get("/api/follow-ups?status=new");
    expect(res.body.followUps).toHaveLength(0);

    const res2 = await request(app).get("/api/follow-ups?status=interested");
    expect(res2.body.followUps).toHaveLength(1);
  });

  it("searches by username", async () => {
    const lead = await createLead({ username: "findme123" });

    await FollowUp.create({
      outbound_lead_id: lead._id,
      account_id: accountId,
    });

    const res = await request(app).get("/api/follow-ups?search=findme");
    expect(res.body.followUps).toHaveLength(1);

    const res2 = await request(app).get("/api/follow-ups?search=notfound");
    expect(res2.body.followUps).toHaveLength(0);
  });
});

describe("GET /api/follow-ups/stats", () => {
  it("returns counts per status", async () => {
    const lead1 = await createLead({ username: "l1" });
    const lead2 = await createLead({ username: "l2" });

    await FollowUp.create({ outbound_lead_id: lead1._id, account_id: accountId, status: "new" });
    await FollowUp.create({ outbound_lead_id: lead2._id, account_id: accountId, status: "interested" });

    const res = await request(app).get("/api/follow-ups/stats");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.new).toBe(1);
    expect(res.body.interested).toBe(1);
    expect(res.body.booked).toBe(0);
  });
});

describe("POST /api/follow-ups/sync", () => {
  it("creates follow-ups for replied leads", async () => {
    await createLead({ username: "replied1", replied: true });
    await createLead({ username: "notreplied", replied: false });

    const res = await request(app).post("/api/follow-ups/sync");
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);

    const count = await FollowUp.countDocuments({ account_id: accountId });
    expect(count).toBe(1);
  });

  it("does not duplicate existing follow-ups", async () => {
    const lead = await createLead({ username: "existing", replied: true });

    await FollowUp.create({
      outbound_lead_id: lead._id,
      account_id: accountId,
    });

    const res = await request(app).post("/api/follow-ups/sync");
    expect(res.body.synced).toBe(0);
  });
});

describe("PATCH /api/follow-ups/:id", () => {
  it("updates status", async () => {
    const lead = await createLead({ username: "u1" });
    const fu = await FollowUp.create({
      outbound_lead_id: lead._id,
      account_id: accountId,
      status: "new",
    });

    const res = await request(app)
      .patch(`/api/follow-ups/${fu._id}`)
      .send({ status: "interested" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("interested");
  });

  it("updates note and follow_up_date", async () => {
    const lead = await createLead({ username: "u2" });
    const fu = await FollowUp.create({
      outbound_lead_id: lead._id,
      account_id: accountId,
    });

    const date = "2026-04-01T00:00:00.000Z";
    const res = await request(app)
      .patch(`/api/follow-ups/${fu._id}`)
      .send({ note: "Call them back", follow_up_date: date });

    expect(res.status).toBe(200);
    expect(res.body.note).toBe("Call them back");
    expect(res.body.follow_up_date).toBe(date);
  });

  it("returns 404 for wrong account", async () => {
    const otherAccount = new mongoose.Types.ObjectId();
    const lead = await OutboundLead.create({ account_id: otherAccount, username: "other", followingKey: "other" });
    const fu = await FollowUp.create({
      outbound_lead_id: lead._id,
      account_id: otherAccount,
    });

    const res = await request(app)
      .patch(`/api/follow-ups/${fu._id}`)
      .send({ status: "booked" });

    expect(res.status).toBe(404);
  });
});

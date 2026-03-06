const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const OutboundLead = require("../models/OutboundLead");
const CampaignLead = require("../models/CampaignLead");
const Campaign = require("../models/Campaign");
const outboundLeadsRouter = require("./outbound-leads");

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
  app.use("/api/outbound-leads", outboundLeadsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await OutboundLead.deleteMany({});
  await CampaignLead.deleteMany({});
  await Campaign.deleteMany({});
});

function createLead(overrides = {}) {
  return OutboundLead.create({
    account_id: accountId,
    followingKey: overrides.username || "user",
    username: "user",
    ...overrides,
  });
}

describe("GET /api/outbound-leads", () => {
  it("returns empty list", async () => {
    const res = await request(app).get("/api/outbound-leads");
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("returns leads for current account only", async () => {
    await createLead({ username: "mine", followingKey: "mine" });
    await OutboundLead.create({
      account_id: new mongoose.Types.ObjectId(),
      followingKey: "theirs",
      username: "theirs",
    });

    const res = await request(app).get("/api/outbound-leads");
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].username).toBe("mine");
  });

  it("searches by username", async () => {
    await createLead({ username: "alice", followingKey: "alice" });
    await createLead({ username: "bob", followingKey: "bob" });

    const res = await request(app).get("/api/outbound-leads?search=alice");
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].username).toBe("alice");
  });

  it("filters by isMessaged", async () => {
    await createLead({ username: "msg", followingKey: "msg", isMessaged: true });
    await createLead({ username: "nomsg", followingKey: "nomsg", isMessaged: null });

    const res = await request(app).get("/api/outbound-leads?isMessaged=true");
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].username).toBe("msg");
  });

  it("filters by replied", async () => {
    await createLead({ username: "replied1", followingKey: "replied1", replied: true });
    await createLead({ username: "norep", followingKey: "norep", replied: false });

    const res = await request(app).get("/api/outbound-leads?replied=true");
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].username).toBe("replied1");
  });

  it("filters by follower range", async () => {
    await createLead({ username: "big", followingKey: "big", followersCount: 50000 });
    await createLead({ username: "small", followingKey: "small", followersCount: 100 });

    const res = await request(app).get("/api/outbound-leads?minFollowers=1000");
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].username).toBe("big");
  });

  it("filters by qualified=false", async () => {
    await createLead({ username: "qual", followingKey: "qual", qualified: true });
    await createLead({ username: "unqual", followingKey: "unqual", qualified: false });

    const res = await request(app).get("/api/outbound-leads?qualified=false");
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].username).toBe("unqual");
  });

  it("paginates correctly", async () => {
    for (let i = 0; i < 5; i++) {
      await createLead({ username: `user${i}`, followingKey: `user${i}` });
    }

    const res = await request(app).get("/api/outbound-leads?page=1&limit=2");
    expect(res.body.leads).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.totalPages).toBe(3);
  });

  it("default excludes explicitly unqualified leads", async () => {
    await createLead({ username: "good", followingKey: "good", qualified: true });
    await createLead({ username: "bad", followingKey: "bad", qualified: false });
    await createLead({ username: "unknown", followingKey: "unknown", qualified: null });

    const res = await request(app).get("/api/outbound-leads");
    // Should return good + unknown (not bad)
    expect(res.body.leads).toHaveLength(2);
    const usernames = res.body.leads.map((l) => l.username);
    expect(usernames).not.toContain("bad");
  });
});

describe("GET /api/outbound-leads/sources", () => {
  it("returns distinct sources", async () => {
    await createLead({ username: "a", followingKey: "a", source: "seedA" });
    await createLead({ username: "b", followingKey: "b", source: "seedB" });

    const res = await request(app).get("/api/outbound-leads/sources");
    expect(res.status).toBe(200);
    expect(res.body.sources).toContain("seedA");
    expect(res.body.sources).toContain("seedB");
  });

  it("strips @ from sources", async () => {
    await createLead({ username: "c", followingKey: "c", source: "@atuser" });

    const res = await request(app).get("/api/outbound-leads/sources");
    expect(res.body.sources).toContain("atuser");
    expect(res.body.sources).not.toContain("@atuser");
  });
});

describe("GET /api/outbound-leads/stats", () => {
  it("returns funnel stats", async () => {
    await createLead({ username: "a", followingKey: "a", isMessaged: true, replied: true, booked: true, contract_value: 500 });
    await createLead({ username: "b", followingKey: "b", isMessaged: true, replied: false });
    await createLead({ username: "c", followingKey: "c" });

    const res = await request(app).get("/api/outbound-leads/stats");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.messaged).toBe(2);
    expect(res.body.replied).toBe(1);
    expect(res.body.booked).toBe(1);
    expect(res.body.contract_value).toBe(500);
  });
});

describe("GET /api/outbound-leads/:id", () => {
  it("returns a single lead", async () => {
    const lead = await createLead({ username: "single", followingKey: "single" });

    const res = await request(app).get(`/api/outbound-leads/${lead._id}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("single");
  });

  it("returns 404 for nonexistent lead", async () => {
    const res = await request(app).get(`/api/outbound-leads/${new mongoose.Types.ObjectId()}`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/outbound-leads/:id", () => {
  it("updates a lead", async () => {
    const lead = await createLead({ username: "patchme", followingKey: "patchme" });

    const res = await request(app)
      .patch(`/api/outbound-leads/${lead._id}`)
      .send({ fullName: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.fullName).toBe("Updated Name");
  });

  it("auto-sets replied_at when replied is toggled true", async () => {
    const lead = await createLead({ username: "rep", followingKey: "rep" });

    const res = await request(app)
      .patch(`/api/outbound-leads/${lead._id}`)
      .send({ replied: true });

    expect(res.status).toBe(200);
    expect(res.body.replied).toBe(true);
    expect(res.body.replied_at).toBeTruthy();
  });

  it("clears replied_at when replied is toggled false", async () => {
    const lead = await createLead({
      username: "unrep",
      followingKey: "unrep",
      replied: true,
      replied_at: new Date(),
    });

    const res = await request(app)
      .patch(`/api/outbound-leads/${lead._id}`)
      .send({ replied: false });

    expect(res.body.replied).toBe(false);
    expect(res.body.replied_at).toBeNull();
  });

  it("auto-sets booked_at when booked is toggled true", async () => {
    const lead = await createLead({ username: "book", followingKey: "book" });

    const res = await request(app)
      .patch(`/api/outbound-leads/${lead._id}`)
      .send({ booked: true });

    expect(res.body.booked).toBe(true);
    expect(res.body.booked_at).toBeTruthy();
  });

  it("syncs CampaignLead status when replied toggled", async () => {
    const lead = await createLead({ username: "sync", followingKey: "sync" });
    const campaign = await Campaign.create({ account_id: accountId, name: "Test", messages: ["hi"] });
    await CampaignLead.create({
      campaign_id: campaign._id,
      outbound_lead_id: lead._id,
      status: "sent",
    });

    await request(app)
      .patch(`/api/outbound-leads/${lead._id}`)
      .send({ replied: true });

    const cl = await CampaignLead.findOne({ outbound_lead_id: lead._id });
    expect(cl.status).toBe("replied");
  });
});

describe("DELETE /api/outbound-leads/:id", () => {
  it("deletes a lead", async () => {
    const lead = await createLead({ username: "del", followingKey: "del" });

    const res = await request(app).delete(`/api/outbound-leads/${lead._id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const found = await OutboundLead.findById(lead._id);
    expect(found).toBeNull();
  });
});

describe("POST /api/outbound-leads/bulk-delete", () => {
  it("deletes by ids", async () => {
    const lead1 = await createLead({ username: "del1", followingKey: "del1" });
    const lead2 = await createLead({ username: "del2", followingKey: "del2" });
    await createLead({ username: "keep", followingKey: "keep" });

    const res = await request(app)
      .post("/api/outbound-leads/bulk-delete")
      .send({ ids: [lead1._id, lead2._id] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);

    const remaining = await OutboundLead.countDocuments({ account_id: accountId });
    expect(remaining).toBe(1);
  });

  it("deletes all matching filters", async () => {
    await createLead({ username: "r1", followingKey: "r1", replied: true });
    await createLead({ username: "r2", followingKey: "r2", replied: true });
    await createLead({ username: "nr", followingKey: "nr", replied: false });

    const res = await request(app)
      .post("/api/outbound-leads/bulk-delete")
      .send({ all: true, filters: { replied: "true" } });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
  });

  it("returns 400 when no ids or filters", async () => {
    const res = await request(app)
      .post("/api/outbound-leads/bulk-delete")
      .send({});

    expect(res.status).toBe(400);
  });
});

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const leadsRouter = require("./leads");

let mongoServer;
let app;
const accountId = new mongoose.Types.ObjectId();
const ghl = "ghl_test_location";

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = { _id: accountId, ghl };
    req.user = { role: 1, userId: new mongoose.Types.ObjectId() };
    next();
  });
  app.use("/api/leads", leadsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Lead.deleteMany({});
  await OutboundLead.deleteMany({});
});

function createLead(overrides = {}) {
  return Lead.create({
    account_id: accountId.toString(),
    first_name: "Test",
    last_name: "User",
    date_created: new Date().toISOString(),
    ...overrides,
  });
}

describe("GET /api/leads", () => {
  it("returns empty list", async () => {
    const res = await request(app).get("/api/leads");
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("returns leads for current account", async () => {
    await createLead({ first_name: "Mine" });
    await Lead.create({ account_id: "other_ghl", first_name: "Theirs", date_created: new Date().toISOString() });

    const res = await request(app).get("/api/leads");
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].first_name).toBe("Mine");
  });

  it("searches by first_name", async () => {
    await createLead({ first_name: "Alice" });
    await createLead({ first_name: "Bob" });

    const res = await request(app).get("/api/leads?search=Alice");
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].first_name).toBe("Alice");
  });

  it("paginates correctly", async () => {
    for (let i = 0; i < 5; i++) {
      await createLead({ first_name: `User${i}` });
    }

    const res = await request(app).get("/api/leads?page=1&limit=2");
    expect(res.body.leads).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.totalPages).toBe(3);
  });

  it("filters by date range", async () => {
    await createLead({ date_created: "2025-01-15T12:00:00.000Z" });
    await createLead({ date_created: "2025-03-15T12:00:00.000Z" });

    const res = await request(app).get("/api/leads?start_date=2025-03-01&end_date=2025-03-31");
    expect(res.body.leads).toHaveLength(1);
  });

  it("sorts by date_created desc by default", async () => {
    await createLead({ first_name: "Old", date_created: "2025-01-01T00:00:00Z" });
    await createLead({ first_name: "New", date_created: "2025-06-01T00:00:00Z" });

    const res = await request(app).get("/api/leads");
    expect(res.body.leads[0].first_name).toBe("New");
  });

  it("excludes outbound-linked leads when exclude_linked=true", async () => {
    await createLead({ first_name: "Inbound" });
    await createLead({ first_name: "Linked", outbound_lead_id: new mongoose.Types.ObjectId() });

    const all = await request(app).get("/api/leads");
    expect(all.body.leads).toHaveLength(2);
    expect(all.body.pagination.total).toBe(2);

    const filtered = await request(app).get("/api/leads?exclude_linked=true");
    expect(filtered.body.leads).toHaveLength(1);
    expect(filtered.body.leads[0].first_name).toBe("Inbound");
    expect(filtered.body.pagination.total).toBe(1);
  });
});

describe("POST /api/leads", () => {
  it("creates a lead", async () => {
    const res = await request(app)
      .post("/api/leads")
      .send({ first_name: "Created", account_id: ghl });

    expect(res.status).toBe(201);
    expect(res.body.first_name).toBe("Created");
  });
});

describe("GET /api/leads/:id", () => {
  it("returns a single lead", async () => {
    const lead = await createLead({ first_name: "Single" });

    const res = await request(app).get(`/api/leads/${lead._id}`);
    expect(res.status).toBe(200);
    expect(res.body.first_name).toBe("Single");
  });

  it("returns 404 for nonexistent lead", async () => {
    const res = await request(app).get(`/api/leads/${new mongoose.Types.ObjectId()}`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/leads/:id", () => {
  it("updates a lead", async () => {
    const lead = await createLead({ first_name: "Before" });

    const res = await request(app)
      .patch(`/api/leads/${lead._id}`)
      .send({ first_name: "After" });

    expect(res.status).toBe(200);
    expect(res.body.first_name).toBe("After");
  });

  it("updates stage dates (follow_up_at, link_sent_at, etc.)", async () => {
    const lead = await createLead();
    const now = new Date().toISOString();

    const res = await request(app)
      .patch(`/api/leads/${lead._id}`)
      .send({ follow_up_at: now, link_sent_at: now });

    expect(res.status).toBe(200);
    expect(res.body.follow_up_at).toBeTruthy();
    expect(res.body.link_sent_at).toBeTruthy();
  });

  it("clears stage dates with null", async () => {
    const lead = await createLead({ follow_up_at: new Date() });

    const res = await request(app)
      .patch(`/api/leads/${lead._id}`)
      .send({ follow_up_at: null });

    expect(res.status).toBe(200);
    expect(res.body.follow_up_at).toBeNull();
  });

  it("updates ghosted_at", async () => {
    const lead = await createLead();
    const now = new Date().toISOString();

    const res = await request(app)
      .patch(`/api/leads/${lead._id}`)
      .send({ ghosted_at: now });

    expect(res.status).toBe(200);
    expect(res.body.ghosted_at).toBeTruthy();
  });

  it("updates email, ig_username, and source", async () => {
    const lead = await createLead();

    const res = await request(app)
      .patch(`/api/leads/${lead._id}`)
      .send({ email: "new@test.com", ig_username: "newhandle", source: "referral" });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("new@test.com");
    expect(res.body.ig_username).toBe("newhandle");
    expect(res.body.source).toBe("referral");
  });

  it("updates score and contract_value", async () => {
    const lead = await createLead();

    const res = await request(app)
      .patch(`/api/leads/${lead._id}`)
      .send({ score: 8, contract_value: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(8);
    expect(res.body.contract_value).toBe(5000);
  });

  it("returns 404 for lead from another account", async () => {
    const lead = await Lead.create({
      account_id: "other_account",
      first_name: "Foreign",
      date_created: new Date().toISOString(),
    });

    const res = await request(app)
      .patch(`/api/leads/${lead._id}`)
      .send({ score: 5 });

    expect(res.status).toBe(404);
  });

  it("returns 404 for nonexistent lead", async () => {
    const res = await request(app)
      .patch(`/api/leads/${new mongoose.Types.ObjectId()}`)
      .send({ score: 5 });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/leads/:id", () => {
  it("deletes a lead", async () => {
    const lead = await createLead();

    const res = await request(app).delete(`/api/leads/${lead._id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const found = await Lead.findById(lead._id);
    expect(found).toBeNull();
  });

  it("returns 404 for lead from another account", async () => {
    const lead = await Lead.create({
      account_id: "other_account",
      first_name: "Foreign",
      date_created: new Date().toISOString(),
    });

    const res = await request(app).delete(`/api/leads/${lead._id}`);
    expect(res.status).toBe(404);

    // Lead should still exist
    const found = await Lead.findById(lead._id);
    expect(found).not.toBeNull();
  });
});

describe("GET /api/leads/:id/ghl-conversation", () => {
  it("returns empty messages when no chat_memory", async () => {
    const lead = await createLead();
    const res = await request(app).get(`/api/leads/${lead._id}/ghl-conversation`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("parses chat_memory into User/Bot messages", async () => {
    const lead = await createLead({
      chat_memory: "\nUser: Hello I need help\nBot: Hi! How can I assist you?\nUser: I want to book a call\nBot: Great, here is the link",
    });

    const res = await request(app).get(`/api/leads/${lead._id}/ghl-conversation`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(4);
    expect(res.body.total).toBe(4);

    expect(res.body.messages[0]).toMatchObject({ role: "user", direction: "inbound", text: "Hello I need help" });
    expect(res.body.messages[1]).toMatchObject({ role: "bot", direction: "outbound", text: "Hi! How can I assist you?" });
    expect(res.body.messages[2]).toMatchObject({ role: "user", direction: "inbound", text: "I want to book a call" });
    expect(res.body.messages[3]).toMatchObject({ role: "bot", direction: "outbound", text: "Great, here is the link" });
  });

  it("returns 404 for nonexistent lead", async () => {
    const res = await request(app).get(`/api/leads/${new mongoose.Types.ObjectId()}/ghl-conversation`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for lead from another account", async () => {
    const lead = await Lead.create({
      account_id: "other_account",
      first_name: "Foreign",
      date_created: new Date().toISOString(),
      chat_memory: "\nUser: hello\nBot: hi",
    });

    const res = await request(app).get(`/api/leads/${lead._id}/ghl-conversation`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/leads/:id — outbound lead population", () => {
  it("populates outbound lead into separate outbound_lead field", async () => {
    const ob = await OutboundLead.create({
      account_id: accountId,
      username: "outbound_user",
      fullName: "Outbound User",
      followingKey: "outbound_user::scrape",
      followersCount: 5000,
      bio: "Coach & Consultant",
      profileLink: "https://www.instagram.com/outbound_user/",
      isMessaged: true,
      dmDate: new Date("2026-03-15"),
      replied: true,
      replied_at: new Date("2026-03-16"),
      booked: false,
      source: "jeremyleeminer",
    });

    const lead = await createLead({
      first_name: "Linked",
      outbound_lead_id: ob._id,
    });

    const res = await request(app).get(`/api/leads/${lead._id}`);
    expect(res.status).toBe(200);

    // outbound_lead_id stays as a raw ID string (not an object)
    expect(typeof res.body.outbound_lead_id).toBe("string");
    expect(res.body.outbound_lead_id).toBe(ob._id.toString());

    // outbound_lead has the populated data
    expect(res.body.outbound_lead).toBeTruthy();
    expect(res.body.outbound_lead.username).toBe("outbound_user");
    expect(res.body.outbound_lead.fullName).toBe("Outbound User");
    expect(res.body.outbound_lead.followersCount).toBe(5000);
    expect(res.body.outbound_lead.isMessaged).toBe(true);
    expect(res.body.outbound_lead.dmDate).toBeTruthy();
    expect(res.body.outbound_lead.replied).toBe(true);
    expect(res.body.outbound_lead.replied_at).toBeTruthy();
    expect(res.body.outbound_lead.source).toBe("jeremyleeminer");
  });

  it("returns null outbound_lead_id and no outbound_lead when not linked", async () => {
    const lead = await createLead({ first_name: "NoLink" });

    const res = await request(app).get(`/api/leads/${lead._id}`);
    expect(res.status).toBe(200);
    expect(res.body.outbound_lead_id).toBeNull();
    expect(res.body.outbound_lead).toBeUndefined();
  });

  it("does not leak sensitive outbound fields", async () => {
    const ob = await OutboundLead.create({
      account_id: accountId,
      username: "secret_user",
      fullName: "Secret",
      followingKey: "secret_user::scrape",
      message: "Hey, this is the DM I sent you",
      qualified: true,
      unqualified_reason: null,
    });

    const lead = await createLead({ outbound_lead_id: ob._id });
    const res = await request(app).get(`/api/leads/${lead._id}`);

    expect(res.body.outbound_lead.username).toBe("secret_user");
    expect(res.body.outbound_lead.message).toBeUndefined();
    expect(res.body.outbound_lead.qualified).toBeUndefined();
    expect(res.body.outbound_lead.unqualified_reason).toBeUndefined();
  });

  it("handles deleted outbound lead gracefully", async () => {
    const deletedId = new mongoose.Types.ObjectId();
    const lead = await createLead({ outbound_lead_id: deletedId });

    const res = await request(app).get(`/api/leads/${lead._id}`);
    expect(res.status).toBe(200);
    expect(res.body.outbound_lead_id).toBe(deletedId.toString());
    expect(res.body.outbound_lead).toBeUndefined();
  });
});

describe("Lead conversation timestamps", () => {
  it("stores conversation_count, first_conversation_at, last_conversation_at", async () => {
    const lead = await createLead({
      first_conversation_at: new Date("2026-03-01"),
      last_conversation_at: new Date("2026-04-01"),
      conversation_count: 15,
    });

    const res = await request(app).get(`/api/leads/${lead._id}`);
    expect(res.status).toBe(200);
    expect(res.body.first_conversation_at).toBeTruthy();
    expect(res.body.last_conversation_at).toBeTruthy();
    expect(res.body.conversation_count).toBe(15);
  });

  it("defaults conversation fields to null/0", async () => {
    const lead = await createLead();

    const res = await request(app).get(`/api/leads/${lead._id}`);
    expect(res.body.first_conversation_at).toBeNull();
    expect(res.body.last_conversation_at).toBeNull();
    expect(res.body.conversation_count).toBe(0);
  });
});

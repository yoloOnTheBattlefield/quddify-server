const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Campaign = require("../models/Campaign");
const CampaignLead = require("../models/CampaignLead");
const OutboundLead = require("../models/OutboundLead");
const OutboundAccount = require("../models/OutboundAccount");
const SenderAccount = require("../models/SenderAccount");

// Mock socketManager and campaignScheduler to avoid real dependencies
jest.mock("../services/socketManager", () => ({
  emitToAccount: jest.fn(),
}));

const campaignsRouter = require("./campaigns");

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
  app.use("/api/campaigns", campaignsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Campaign.deleteMany({});
  await CampaignLead.deleteMany({});
  await OutboundLead.deleteMany({});
  await OutboundAccount.deleteMany({});
  await SenderAccount.deleteMany({});
});

function createCampaign(overrides = {}) {
  return Campaign.create({
    account_id: accountId,
    name: "Test Campaign",
    messages: ["Hi {{username}}"],
    ...overrides,
  });
}

describe("GET /api/campaigns", () => {
  it("returns empty list", async () => {
    const res = await request(app).get("/api/campaigns");
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("returns campaigns for current account only", async () => {
    await createCampaign({ name: "Mine" });
    await Campaign.create({ account_id: new mongoose.Types.ObjectId(), name: "Theirs", messages: [] });

    const res = await request(app).get("/api/campaigns");
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].name).toBe("Mine");
  });

  it("filters by status", async () => {
    await createCampaign({ name: "Active", status: "active" });
    await createCampaign({ name: "Draft", status: "draft" });

    const res = await request(app).get("/api/campaigns?status=active");
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].name).toBe("Active");
  });

  it("paginates results", async () => {
    for (let i = 0; i < 5; i++) {
      await createCampaign({ name: `Campaign ${i}` });
    }

    const res = await request(app).get("/api/campaigns?page=1&limit=2");
    expect(res.body.campaigns).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.totalPages).toBe(3);
  });
});

describe("POST /api/campaigns", () => {
  it("creates a campaign", async () => {
    const res = await request(app)
      .post("/api/campaigns")
      .send({ name: "New Campaign", messages: ["Hello"] });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("New Campaign");
    expect(res.body.status).toBe("draft");
    expect(res.body.mode).toBe("auto");
  });

  it("creates a manual campaign", async () => {
    const res = await request(app)
      .post("/api/campaigns")
      .send({ name: "Manual", mode: "manual" });

    expect(res.status).toBe(201);
    expect(res.body.mode).toBe("manual");
  });

  it("returns 400 for missing name", async () => {
    const res = await request(app)
      .post("/api/campaigns")
      .send({ messages: ["hi"] });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid mode", async () => {
    const res = await request(app)
      .post("/api/campaigns")
      .send({ name: "Bad", mode: "invalid" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/campaigns/:id", () => {
  it("returns a single campaign", async () => {
    const c = await createCampaign({ name: "Single" });

    const res = await request(app).get(`/api/campaigns/${c._id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Single");
  });

  it("returns 404 for wrong account", async () => {
    const c = await Campaign.create({
      account_id: new mongoose.Types.ObjectId(),
      name: "NotMine",
      messages: [],
    });

    const res = await request(app).get(`/api/campaigns/${c._id}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid id", async () => {
    const res = await request(app).get("/api/campaigns/invalid");
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/campaigns/:id", () => {
  it("updates a draft campaign", async () => {
    const c = await createCampaign({ name: "Before", status: "draft" });

    const res = await request(app)
      .patch(`/api/campaigns/${c._id}`)
      .send({ name: "After" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("After");
  });

  it("updates a paused campaign", async () => {
    const c = await createCampaign({ status: "paused" });

    const res = await request(app)
      .patch(`/api/campaigns/${c._id}`)
      .send({ name: "Updated Paused" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Paused");
  });

  it("rejects update on active campaign", async () => {
    const c = await createCampaign({ status: "active" });

    const res = await request(app)
      .patch(`/api/campaigns/${c._id}`)
      .send({ name: "Nope" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pause/i);
  });

  it("validates schedule constraints", async () => {
    const c = await createCampaign({ status: "draft" });

    const res = await request(app)
      .patch(`/api/campaigns/${c._id}`)
      .send({ schedule: { min_delay_seconds: 5 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation failed/i);
  });

  it("validates max_delay >= min_delay", async () => {
    const c = await createCampaign({ status: "draft" });

    const res = await request(app)
      .patch(`/api/campaigns/${c._id}`)
      .send({ schedule: { min_delay_seconds: 100, max_delay_seconds: 50 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max_delay_seconds/);
  });
});

describe("DELETE /api/campaigns/:id", () => {
  it("deletes a draft campaign and its leads", async () => {
    const c = await createCampaign({ status: "draft" });
    const ol = await OutboundLead.create({
      account_id: accountId,
      followingKey: "user1",
      username: "user1",
    });
    await CampaignLead.create({ campaign_id: c._id, outbound_lead_id: ol._id });

    const res = await request(app).delete(`/api/campaigns/${c._id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const foundCampaign = await Campaign.findById(c._id);
    expect(foundCampaign).toBeNull();

    const foundLeads = await CampaignLead.countDocuments({ campaign_id: c._id });
    expect(foundLeads).toBe(0);
  });

  it("rejects deletion of active campaign", async () => {
    const c = await createCampaign({ status: "active" });

    const res = await request(app).delete(`/api/campaigns/${c._id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pause/i);
  });
});

describe("POST /api/campaigns/:id/start", () => {
  it("starts a draft campaign with required fields", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "sender1" });
    const c = await createCampaign({
      status: "draft",
      outbound_account_ids: [oa._id],
    });
    const ol = await OutboundLead.create({
      account_id: accountId,
      followingKey: "target",
      username: "target",
    });
    await CampaignLead.create({
      campaign_id: c._id,
      outbound_lead_id: ol._id,
      status: "pending",
    });

    const res = await request(app).post(`/api/campaigns/${c._id}/start`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
  });

  it("rejects start without messages", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "sender2" });
    const c = await createCampaign({
      status: "draft",
      messages: [],
      outbound_account_ids: [oa._id],
    });

    const res = await request(app).post(`/api/campaigns/${c._id}/start`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
  });

  it("rejects start without outbound accounts", async () => {
    const c = await createCampaign({ status: "draft", outbound_account_ids: [] });

    const res = await request(app).post(`/api/campaigns/${c._id}/start`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outbound account/i);
  });

  it("rejects start without pending leads", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "sender3" });
    const c = await createCampaign({
      status: "draft",
      outbound_account_ids: [oa._id],
    });

    const res = await request(app).post(`/api/campaigns/${c._id}/start`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pending leads/i);
  });

  it("rejects start on already active campaign", async () => {
    const c = await createCampaign({ status: "active" });

    const res = await request(app).post(`/api/campaigns/${c._id}/start`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already active/i);
  });

  it("rejects start on completed campaign", async () => {
    const c = await createCampaign({ status: "completed" });

    const res = await request(app).post(`/api/campaigns/${c._id}/start`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/completed/i);
  });
});

describe("POST /api/campaigns/:id/pause", () => {
  it("pauses an active campaign", async () => {
    const c = await createCampaign({ status: "active" });

    const res = await request(app).post(`/api/campaigns/${c._id}/pause`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paused");
  });

  it("rejects pausing a non-active campaign", async () => {
    const c = await createCampaign({ status: "draft" });

    const res = await request(app).post(`/api/campaigns/${c._id}/pause`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/active/i);
  });
});

describe("GET /api/campaigns/:id/stats", () => {
  it("returns campaign stats with replied/booked counts", async () => {
    const c = await createCampaign({
      stats: { total: 10, pending: 5, sent: 5, queued: 0, delivered: 0, replied: 0, failed: 0, skipped: 0 },
    });
    const ol = await OutboundLead.create({
      account_id: accountId,
      followingKey: "statuser",
      username: "statuser",
      replied: true,
      booked: true,
    });
    await CampaignLead.create({
      campaign_id: c._id,
      outbound_lead_id: ol._id,
      status: "sent",
    });

    const res = await request(app).get(`/api/campaigns/${c._id}/stats`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(10);
    expect(res.body.replied).toBe(1);
    expect(res.body.booked).toBe(1);
  });
});

describe("POST /api/campaigns/:id/leads", () => {
  it("adds leads to a campaign", async () => {
    const c = await createCampaign();
    const ol1 = await OutboundLead.create({ account_id: accountId, followingKey: "lead1", username: "lead1" });
    const ol2 = await OutboundLead.create({ account_id: accountId, followingKey: "lead2", username: "lead2" });

    const res = await request(app)
      .post(`/api/campaigns/${c._id}/leads`)
      .send({ lead_ids: [ol1._id, ol2._id] });

    expect(res.status).toBe(201);
    expect(res.body.added).toBe(2);
    expect(res.body.duplicates_skipped).toBe(0);

    const count = await CampaignLead.countDocuments({ campaign_id: c._id });
    expect(count).toBe(2);
  });

  it("skips duplicate leads", async () => {
    const c = await createCampaign();
    const ol = await OutboundLead.create({ account_id: accountId, followingKey: "dup", username: "dup" });
    await CampaignLead.create({ campaign_id: c._id, outbound_lead_id: ol._id, status: "pending" });

    const res = await request(app)
      .post(`/api/campaigns/${c._id}/leads`)
      .send({ lead_ids: [ol._id] });

    expect(res.body.added).toBe(0);
    expect(res.body.duplicates_skipped).toBe(1);
  });

  it("returns 400 for empty lead_ids", async () => {
    const c = await createCampaign();

    const res = await request(app)
      .post(`/api/campaigns/${c._id}/leads`)
      .send({ lead_ids: [] });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/campaigns/:id/start — AI personalization", () => {
  it("allows start when campaign has AI-generated messages but no templates", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "ai_sender" });
    const c = await createCampaign({
      status: "draft",
      messages: [],
      outbound_account_ids: [oa._id],
      ai_personalization: { enabled: true, status: "completed", progress: 1, total: 1 },
    });
    const ol = await OutboundLead.create({
      account_id: accountId,
      followingKey: "ai_target",
      username: "ai_target",
    });
    await CampaignLead.create({
      campaign_id: c._id,
      outbound_lead_id: ol._id,
      status: "pending",
      custom_message: "are you still relying on live launches?",
    });

    const res = await request(app).post(`/api/campaigns/${c._id}/start`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
  });

  it("rejects start with no messages AND no AI personalization", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "no_msg_sender" });
    const c = await createCampaign({
      status: "draft",
      messages: [],
      outbound_account_ids: [oa._id],
      ai_personalization: { enabled: false, status: "idle" },
    });
    const ol = await OutboundLead.create({
      account_id: accountId,
      followingKey: "no_msg_target",
      username: "no_msg_target",
    });
    await CampaignLead.create({
      campaign_id: c._id,
      outbound_lead_id: ol._id,
      status: "pending",
    });

    const res = await request(app).post(`/api/campaigns/${c._id}/start`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
  });

  it("rejects start when AI personalization is still generating", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "gen_sender" });
    const c = await createCampaign({
      status: "draft",
      messages: [],
      outbound_account_ids: [oa._id],
      ai_personalization: { enabled: true, status: "generating", progress: 5, total: 100 },
    });
    const ol = await OutboundLead.create({
      account_id: accountId,
      followingKey: "gen_target",
      username: "gen_target",
    });
    await CampaignLead.create({
      campaign_id: c._id,
      outbound_lead_id: ol._id,
      status: "pending",
    });

    const res = await request(app).post(`/api/campaigns/${c._id}/start`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
  });
});

describe("GET /api/campaigns/:id/next-send", () => {
  it("returns estimate for active campaign with online senders", async () => {
    const oa = await OutboundAccount.create({
      account_id: accountId,
      username: "next_sender",
      status: "ready",
    });
    await SenderAccount.create({
      account_id: accountId,
      ig_username: "next_sender",
      outbound_account_id: oa._id,
      status: "online",
      last_seen: new Date(),
    });

    const c = await createCampaign({
      status: "active",
      outbound_account_ids: [oa._id],
      stats: { total: 10, pending: 5, queued: 0, sent: 5, failed: 0, skipped: 0 },
    });

    const res = await request(app).get(`/api/campaigns/${c._id}/next-send`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.online_senders).toBe(1);
    expect(res.body.total_senders).toBe(1);
    expect(res.body.delay_seconds).toBeGreaterThan(0);
    expect(res.body.next_send_at).toBeDefined();
  });

  it("returns paused status for non-active campaign", async () => {
    const c = await createCampaign({ status: "paused" });

    const res = await request(app).get(`/api/campaigns/${c._id}/next-send`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paused");
    expect(res.body.reason).toMatch(/paused/i);
    expect(res.body.next_send_at).toBeNull();
  });

  it("reports no senders linked", async () => {
    const c = await createCampaign({
      status: "active",
      outbound_account_ids: [],
    });

    const res = await request(app).get(`/api/campaigns/${c._id}/next-send`);
    expect(res.status).toBe(200);
    expect(res.body.reason).toMatch(/no sender/i);
  });

  it("reports no senders online", async () => {
    const oa = await OutboundAccount.create({
      account_id: accountId,
      username: "offline_ns",
      status: "ready",
    });
    await SenderAccount.create({
      account_id: accountId,
      ig_username: "offline_ns",
      outbound_account_id: oa._id,
      status: "offline",
      last_seen: new Date(Date.now() - 120_000),
    });

    const c = await createCampaign({
      status: "active",
      outbound_account_ids: [oa._id],
      stats: { total: 10, pending: 5, queued: 0, sent: 5, failed: 0, skipped: 0 },
      schedule: { active_hours_start: 0, active_hours_end: 24, timezone: "UTC", skip_active_hours: true },
    });

    const res = await request(app).get(`/api/campaigns/${c._id}/next-send`);
    expect(res.status).toBe(200);
    expect(res.body.reason).toMatch(/no senders online/i);
  });

  it("returns 404 for wrong account", async () => {
    const c = await Campaign.create({
      account_id: new mongoose.Types.ObjectId(),
      name: "Other",
      messages: ["hi"],
      status: "active",
    });

    const res = await request(app).get(`/api/campaigns/${c._id}/next-send`);
    expect(res.status).toBe(404);
  });

  it("handles campaign with burst mode", async () => {
    const oa = await OutboundAccount.create({
      account_id: accountId,
      username: "burst_sender",
      status: "ready",
    });
    await SenderAccount.create({
      account_id: accountId,
      ig_username: "burst_sender",
      outbound_account_id: oa._id,
      status: "online",
      last_seen: new Date(),
    });

    const c = await createCampaign({
      status: "active",
      outbound_account_ids: [oa._id],
      stats: { total: 10, pending: 5, queued: 0, sent: 5, failed: 0, skipped: 0 },
      schedule: {
        active_hours_start: 0,
        active_hours_end: 24,
        timezone: "UTC",
        burst_enabled: true,
        messages_per_group: 5,
      },
      burst_break_until: new Date(Date.now() + 300_000),
      burst_sent_in_group: 0,
    });

    const res = await request(app).get(`/api/campaigns/${c._id}/next-send`);
    expect(res.status).toBe(200);
    expect(res.body.burst_enabled).toBe(true);
    expect(res.body.burst_on_break).toBe(true);
    expect(res.body.reason).toMatch(/burst.*break/i);
  });
});

describe("POST /api/campaigns/:id/recalc-stats", () => {
  it("recalculates stats from campaign leads", async () => {
    const c = await createCampaign();
    const ol1 = await OutboundLead.create({ account_id: accountId, followingKey: "s1", username: "s1", replied: true });
    const ol2 = await OutboundLead.create({ account_id: accountId, followingKey: "s2", username: "s2" });
    await CampaignLead.create({ campaign_id: c._id, outbound_lead_id: ol1._id, status: "sent" });
    await CampaignLead.create({ campaign_id: c._id, outbound_lead_id: ol2._id, status: "pending" });

    const res = await request(app).post(`/api/campaigns/${c._id}/recalc-stats`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.sent).toBe(1);
    expect(res.body.pending).toBe(1);
    expect(res.body.replied).toBe(1);
  });
});

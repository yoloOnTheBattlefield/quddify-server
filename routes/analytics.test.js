const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const Campaign = require("../models/Campaign");
const CampaignLead = require("../models/CampaignLead");
const SenderAccount = require("../models/SenderAccount");
const Account = require("../models/Account");

jest.mock("../utils/logger", () => {
  const noop = () => {};
  const logger = { info: noop, error: noop, warn: noop, debug: noop, child: () => logger };
  return logger;
});

const analyticsRouter = require("./analytics");

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
  app.use("/api/analytics", analyticsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Lead.deleteMany({});
  await OutboundLead.deleteMany({});
  await Campaign.deleteMany({});
  await CampaignLead.deleteMany({});
  await SenderAccount.deleteMany({});
  await Account.deleteMany({});
});

// ── Helpers ──────────────────────────────────────────────────────────────

function createLead(overrides = {}) {
  return Lead.create({
    account_id: ghl,
    first_name: "Test",
    last_name: "User",
    date_created: "2025-06-15T12:00:00.000Z",
    ...overrides,
  });
}

function createOutboundLead(overrides = {}) {
  return OutboundLead.create({
    account_id: accountId,
    followingKey: `key_${Date.now()}_${Math.random()}`,
    username: `user_${Date.now()}_${Math.random()}`,
    isMessaged: true,
    dmDate: new Date("2025-06-15T12:00:00.000Z"),
    ...overrides,
  });
}

// ── GET /api/analytics (main dashboard) ─────────────────────────────────

describe("GET /api/analytics", () => {
  it("returns all sections with empty data", async () => {
    const res = await request(app).get("/api/analytics?start_date=2025-06-01&end_date=2025-06-30");
    expect(res.status).toBe(200);
    expect(res.body.funnel).toBeDefined();
    expect(res.body.velocity).toBeDefined();
    expect(res.body.dailyVolume).toBeDefined();
    expect(res.body.ghosting).toBeDefined();
    expect(res.body.fup).toBeDefined();
    expect(res.body.aging).toBeDefined();
    expect(res.body.cumulative).toBeDefined();
    expect(res.body.radar).toBeDefined();
  });

  it("computes funnel metrics correctly", async () => {
    await createLead({ link_sent_at: new Date("2025-06-15T14:00:00Z") });
    await createLead({
      link_sent_at: new Date("2025-06-15T14:00:00Z"),
      booked_at: new Date("2025-06-16T10:00:00Z"),
    });
    await createLead({ ghosted_at: new Date("2025-06-16T10:00:00Z") });

    const res = await request(app).get("/api/analytics?start_date=2025-06-01&end_date=2025-06-30");
    expect(res.status).toBe(200);

    const { funnel } = res.body;
    expect(funnel.totalContacts).toBe(3);
    expect(funnel.linkSentCount).toBe(2);
    expect(funnel.bookedCount).toBe(1);
    expect(funnel.ghostedCount).toBe(1);
  });

  it("computes outbound funnel metrics", async () => {
    await createOutboundLead({ replied: true });
    await createOutboundLead({ replied: true, booked: true });
    await createOutboundLead({ replied: false });

    const res = await request(app).get("/api/analytics?start_date=2025-06-01&end_date=2025-06-30");
    expect(res.status).toBe(200);

    const { funnel } = res.body;
    expect(funnel.obMessaged).toBe(3);
    expect(funnel.obReplied).toBe(2);
    expect(funnel.obBooked).toBe(1);
  });

  it("filters by date range", async () => {
    await createLead({ date_created: "2025-06-15T12:00:00.000Z" });
    await createLead({ date_created: "2025-07-15T12:00:00.000Z" });

    const res = await request(app).get("/api/analytics?start_date=2025-06-01&end_date=2025-06-30");
    expect(res.body.funnel.totalContacts).toBe(1);
  });

  it("filters outbound by source=inbound", async () => {
    await createLead({});
    await createOutboundLead({});

    const res = await request(app).get("/api/analytics?start_date=2025-06-01&end_date=2025-06-30&source=inbound");
    expect(res.body.funnel.totalContacts).toBe(1);
    expect(res.body.funnel.obMessaged).toBe(0);
  });

  it("filters inbound by source=outbound", async () => {
    await createLead({});
    await createOutboundLead({});

    const res = await request(app).get("/api/analytics?start_date=2025-06-01&end_date=2025-06-30&source=outbound");
    expect(res.body.funnel.totalContacts).toBe(0);
    expect(res.body.funnel.obMessaged).toBe(1);
  });
});

// ── GET /api/analytics/outbound ─────────────────────────────────────────

describe("GET /api/analytics/outbound", () => {
  it("returns outbound funnel with zero counts when empty", async () => {
    const res = await request(app).get("/api/analytics/outbound");
    expect(res.status).toBe(200);
    expect(res.body.messaged).toBe(0);
    expect(res.body.replied).toBe(0);
    expect(res.body.booked).toBe(0);
    expect(res.body.reply_rate).toBe(0);
  });

  it("returns correct outbound funnel counts", async () => {
    await createOutboundLead({ replied: true, booked: false });
    await createOutboundLead({ replied: true, booked: true, contract_value: 500 });
    await createOutboundLead({ replied: false });

    const res = await request(app).get("/api/analytics/outbound");
    expect(res.status).toBe(200);
    expect(res.body.messaged).toBe(3);
    expect(res.body.replied).toBe(2);
    expect(res.body.booked).toBe(1);
    expect(res.body.contracts).toBe(1);
    expect(res.body.contract_value).toBe(500);
  });

  it("filters by date range", async () => {
    await createOutboundLead({ dmDate: new Date("2025-06-10T12:00:00Z") });
    await createOutboundLead({ dmDate: new Date("2025-07-10T12:00:00Z") });

    const res = await request(app).get("/api/analytics/outbound?start_date=2025-06-01&end_date=2025-06-30");
    expect(res.body.messaged).toBe(1);
  });

  it("scopes to campaign when campaign_id provided", async () => {
    const camp = await Campaign.create({
      account_id: accountId,
      name: "Test Campaign",
      messages: ["Hi"],
    });
    const ol1 = await createOutboundLead({ replied: true });
    const ol2 = await createOutboundLead({ replied: false });
    await CampaignLead.create({ campaign_id: camp._id, outbound_lead_id: ol1._id, status: "sent" });
    // ol2 is NOT in this campaign

    const res = await request(app).get(`/api/analytics/outbound?campaign_id=${camp._id}`);
    expect(res.body.messaged).toBe(1);
    expect(res.body.replied).toBe(1);
  });
});

// ── GET /api/analytics/outbound/daily ───────────────────────────────────

describe("GET /api/analytics/outbound/daily", () => {
  it("returns empty days array when no data", async () => {
    const res = await request(app).get("/api/analytics/outbound/daily");
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(0);
  });

  it("groups outbound leads by day", async () => {
    await createOutboundLead({ dmDate: new Date("2025-06-10T08:00:00Z"), replied: true });
    await createOutboundLead({ dmDate: new Date("2025-06-10T14:00:00Z"), replied: false });
    await createOutboundLead({ dmDate: new Date("2025-06-11T10:00:00Z"), booked: true });

    const res = await request(app).get("/api/analytics/outbound/daily");
    expect(res.status).toBe(200);
    expect(res.body.days.length).toBeGreaterThanOrEqual(2);

    const june10 = res.body.days.find((d) => d.date === "2025-06-10");
    expect(june10.sent).toBe(2);
    expect(june10.replied).toBe(1);
  });
});

// ── GET /api/analytics/outbound/effort-outcome ──────────────────────────

describe("GET /api/analytics/outbound/effort-outcome", () => {
  it("returns zeroes with no data", async () => {
    const res = await request(app).get("/api/analytics/outbound/effort-outcome");
    expect(res.status).toBe(200);
    expect(res.body.messages_per_reply).toBe(0);
    expect(res.body.messages_per_booking).toBe(0);
  });

  it("computes effort ratios", async () => {
    await createOutboundLead({ replied: true, booked: true });
    await createOutboundLead({ replied: true, booked: false });
    await createOutboundLead({ replied: false, booked: false });

    const res = await request(app).get("/api/analytics/outbound/effort-outcome");
    expect(res.status).toBe(200);
    expect(res.body.messages_per_reply).toBe(1.5); // 3 / 2
    expect(res.body.messages_per_booking).toBe(3); // 3 / 1
    expect(res.body.replies_per_booking).toBe(2); // 2 / 1
  });
});

// ── GET /api/analytics/outbound/response-speed ──────────────────────────

describe("GET /api/analytics/outbound/response-speed", () => {
  it("returns zeroes when no replied leads", async () => {
    const res = await request(app).get("/api/analytics/outbound/response-speed");
    expect(res.status).toBe(200);
    expect(res.body.avg_prospect_reply_time_min).toBe(0);
    expect(res.body.unanswered_count).toBe(0);
    expect(res.body.distribution).toBeDefined();
  });

  it("computes response time metrics", async () => {
    await createOutboundLead({
      replied: true,
      dmDate: new Date("2025-06-10T10:00:00Z"),
      replied_at: new Date("2025-06-10T10:30:00Z"), // 30 min
    });
    await createOutboundLead({
      replied: true,
      dmDate: new Date("2025-06-10T10:00:00Z"),
      replied_at: new Date("2025-06-10T11:00:00Z"), // 60 min
      booked: false,
    });

    const res = await request(app).get("/api/analytics/outbound/response-speed");
    expect(res.status).toBe(200);
    expect(res.body.avg_prospect_reply_time_min).toBe(45);
    expect(res.body.unanswered_count).toBe(2); // replied but not booked
  });
});

// ── GET /api/analytics/outbound/trends ──────────────────────────────────

describe("GET /api/analytics/outbound/trends", () => {
  it("returns empty trends when no data", async () => {
    const res = await request(app).get("/api/analytics/outbound/trends");
    expect(res.status).toBe(200);
    expect(res.body.trends).toHaveLength(0);
  });

  it("computes 7-day rolling rates", async () => {
    // Create data across 8+ days to get at least one trend point
    for (let i = 0; i < 8; i++) {
      const date = new Date(`2025-06-${String(i + 1).padStart(2, "0")}T12:00:00Z`);
      await createOutboundLead({
        dmDate: date,
        replied: i % 2 === 0,
        booked: i === 0,
      });
    }

    const res = await request(app).get("/api/analytics/outbound/trends");
    expect(res.status).toBe(200);
    expect(res.body.trends.length).toBeGreaterThanOrEqual(1);
    expect(res.body.trends[0].reply_rate_7d).toBeDefined();
    expect(res.body.trends[0].booked_rate_7d).toBeDefined();
  });
});

// ── GET /api/analytics/campaigns ────────────────────────────────────────

describe("GET /api/analytics/campaigns", () => {
  it("returns empty campaigns when none exist", async () => {
    const res = await request(app).get("/api/analytics/campaigns");
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(0);
  });

  it("returns campaign analytics with reply counts", async () => {
    const camp = await Campaign.create({
      account_id: accountId,
      name: "Analytics Campaign",
      messages: ["Hello {{username}}"],
    });
    const ol1 = await createOutboundLead({ replied: true });
    const ol2 = await createOutboundLead({ replied: false });
    await CampaignLead.create({
      campaign_id: camp._id,
      outbound_lead_id: ol1._id,
      status: "sent",
    });
    await CampaignLead.create({
      campaign_id: camp._id,
      outbound_lead_id: ol2._id,
      status: "sent",
    });

    const res = await request(app).get("/api/analytics/campaigns");
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].name).toBe("Analytics Campaign");
    expect(res.body.campaigns[0].sent).toBe(2);
    expect(res.body.campaigns[0].replied).toBe(1);
  });
});

// ── GET /api/analytics/messages ─────────────────────────────────────────

describe("GET /api/analytics/messages", () => {
  it("returns empty messages when none exist", async () => {
    const res = await request(app).get("/api/analytics/messages");
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(0);
  });

  it("groups by message text and computes reply rates", async () => {
    await createOutboundLead({ message: "Hello {{username}}", replied: true });
    await createOutboundLead({ message: "Hello {{username}}", replied: false });
    await createOutboundLead({ message: "Different message", replied: true });

    const res = await request(app).get("/api/analytics/messages");
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2);

    const helloMsg = res.body.messages.find((m) => m.message === "Hello {{username}}");
    expect(helloMsg.sent).toBe(2);
    expect(helloMsg.replied).toBe(1);
    expect(helloMsg.reply_rate).toBe(50);
  });
});

// ── GET /api/analytics/inbound ──────────────────────────────────────────

describe("GET /api/analytics/inbound", () => {
  it("returns zeroes when no inbound leads", async () => {
    const res = await request(app).get("/api/analytics/inbound");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.booked).toBe(0);
    expect(res.body.sources).toHaveLength(0);
  });

  it("computes inbound KPIs and source breakdown", async () => {
    await createLead({
      source: "manychat:dm",
      booked_at: new Date("2025-06-16T10:00:00Z"),
      contract_value: 1000,
      closed_at: new Date("2025-06-20T10:00:00Z"),
    });
    await createLead({ source: "manychat:dm" });
    await createLead({ source: "manychat:comment" });

    const res = await request(app).get("/api/analytics/inbound");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.booked).toBe(1);
    expect(res.body.closed).toBe(1);
    expect(res.body.revenue).toBe(1000);
    expect(res.body.sources).toHaveLength(2);

    const dmSource = res.body.sources.find((s) => s.source === "manychat:dm");
    expect(dmSource.total).toBe(2);
    expect(dmSource.booked).toBe(1);
  });
});

// ── GET /api/analytics/inbound/posts ────────────────────────────────────

describe("GET /api/analytics/inbound/posts", () => {
  it("returns empty posts when no leads", async () => {
    const res = await request(app).get("/api/analytics/inbound/posts");
    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(0);
  });

  it("groups leads by post_url", async () => {
    await createLead({ post_url: "https://ig.com/p/1", booked_at: new Date() });
    await createLead({ post_url: "https://ig.com/p/1" });
    await createLead({ post_url: "https://ig.com/p/2" });

    const res = await request(app).get("/api/analytics/inbound/posts");
    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(2);

    const post1 = res.body.posts.find((p) => p.post_url === "https://ig.com/p/1");
    expect(post1.total).toBe(2);
    expect(post1.booked).toBe(1);
  });
});

// ── GET /api/analytics/inbound/daily ────────────────────────────────────

describe("GET /api/analytics/inbound/daily", () => {
  it("returns empty days when no leads", async () => {
    const res = await request(app).get("/api/analytics/inbound/daily");
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(0);
  });

  it("groups leads by creation date", async () => {
    await createLead({ date_created: "2025-06-10T10:00:00.000Z" });
    await createLead({ date_created: "2025-06-10T14:00:00.000Z" });
    await createLead({ date_created: "2025-06-11T10:00:00.000Z" });

    const res = await request(app).get("/api/analytics/inbound/daily");
    expect(res.status).toBe(200);

    const june10 = res.body.days.find((d) => d.date === "2025-06-10");
    expect(june10.created).toBe(2);
  });
});

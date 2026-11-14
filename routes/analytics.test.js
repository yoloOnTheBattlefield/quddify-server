const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Lead = require("../models/Lead");
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

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = { _id: accountId };
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
  await Account.deleteMany({});
});

// ── Helpers ──────────────────────────────────────────────────────────────

function createLead(overrides = {}) {
  return Lead.create({
    account_id: accountId.toString(),
    first_name: "Test",
    last_name: "User",
    date_created: "2025-06-15T12:00:00.000Z",
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

  it("filters by date range", async () => {
    await createLead({ date_created: "2025-06-15T12:00:00.000Z" });
    await createLead({ date_created: "2025-07-15T12:00:00.000Z" });

    const res = await request(app).get("/api/analytics?start_date=2025-06-01&end_date=2025-06-30");
    expect(res.body.funnel.totalContacts).toBe(1);
  });

  it("returns no outbound or combined fields", async () => {
    await createLead({});
    const res = await request(app).get("/api/analytics?start_date=2025-06-01&end_date=2025-06-30");
    expect(res.body.funnel.totalContacts).toBe(1);
    expect(res.body.funnel.obMessaged).toBeUndefined();
    expect(res.body.funnel.combinedContacts).toBeUndefined();
    expect(res.body.cumulative[0].ob_cumulative).toBeUndefined();
  });
});

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

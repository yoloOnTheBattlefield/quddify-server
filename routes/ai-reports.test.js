const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const AnalyticsReport = require("../models/AnalyticsReport");
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

jest.mock("../services/analyticsReportGenerator", () => ({
  generateAndSaveReport: jest.fn().mockResolvedValue(undefined),
}));

const analyticsRouter = require("./analytics");

let mongoServer;
let app;
const accountId = new mongoose.Types.ObjectId();
const otherAccountId = new mongoose.Types.ObjectId();

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
  await AnalyticsReport.deleteMany({});
});

// ── POST /api/analytics/outbound/ai-report ──────────────

describe("POST /api/analytics/outbound/ai-report", () => {
  it("creates a report with generating status and returns report_id", async () => {
    const res = await request(app)
      .post("/api/analytics/outbound/ai-report")
      .send({ start_date: "2025-06-01", end_date: "2025-06-30" });

    expect(res.status).toBe(200);
    expect(res.body.report_id).toBeDefined();
    expect(res.body.status).toBe("generating");

    const doc = await AnalyticsReport.findById(res.body.report_id);
    expect(doc).not.toBeNull();
    expect(doc.status).toBe("generating");
    expect(doc.account_id.toString()).toBe(accountId.toString());
    expect(doc.type).toBe("on_demand");
  });

  it("creates report with campaign_id when provided", async () => {
    const campaignId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .post("/api/analytics/outbound/ai-report")
      .send({ start_date: "2025-06-01", end_date: "2025-06-30", campaign_id: campaignId.toString() });

    expect(res.status).toBe(200);
    const doc = await AnalyticsReport.findById(res.body.report_id);
    expect(doc.campaign_id.toString()).toBe(campaignId.toString());
  });

  it("defaults date range when not provided", async () => {
    const res = await request(app)
      .post("/api/analytics/outbound/ai-report")
      .send({});

    expect(res.status).toBe(200);
    const doc = await AnalyticsReport.findById(res.body.report_id);
    expect(doc.date_range.start).toBeDefined();
    expect(doc.date_range.end).toBeDefined();
  });
});

// ── GET /api/analytics/outbound/ai-reports ──────────────

describe("GET /api/analytics/outbound/ai-reports", () => {
  it("returns empty array when no reports exist", async () => {
    const res = await request(app).get("/api/analytics/outbound/ai-reports");
    expect(res.status).toBe(200);
    expect(res.body.reports).toEqual([]);
  });

  it("returns reports for the account sorted by generated_at desc", async () => {
    await AnalyticsReport.create({
      account_id: accountId,
      type: "on_demand",
      status: "completed",
      date_range: { start: new Date("2025-06-01"), end: new Date("2025-06-30") },
      report: { executive_summary: "First report", overall_health: "green" },
      generated_at: new Date("2025-07-01"),
    });
    await AnalyticsReport.create({
      account_id: accountId,
      type: "on_demand",
      status: "completed",
      date_range: { start: new Date("2025-07-01"), end: new Date("2025-07-31") },
      report: { executive_summary: "Second report", overall_health: "yellow" },
      generated_at: new Date("2025-08-01"),
    });

    const res = await request(app).get("/api/analytics/outbound/ai-reports");
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(2);
    expect(res.body.reports[0].report.executive_summary).toBe("Second report");
  });

  it("does not return reports from other accounts", async () => {
    await AnalyticsReport.create({
      account_id: otherAccountId,
      type: "on_demand",
      status: "completed",
      date_range: { start: new Date("2025-06-01"), end: new Date("2025-06-30") },
      report: { executive_summary: "Other account report" },
    });

    const res = await request(app).get("/api/analytics/outbound/ai-reports");
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(0);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await AnalyticsReport.create({
        account_id: accountId,
        type: "on_demand",
        status: "completed",
        date_range: { start: new Date("2025-06-01"), end: new Date("2025-06-30") },
        generated_at: new Date(Date.now() + i),
      });
    }

    const res = await request(app).get("/api/analytics/outbound/ai-reports?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(2);
  });
});

// ── GET /api/analytics/outbound/ai-reports/:id ──────────

describe("GET /api/analytics/outbound/ai-reports/:id", () => {
  it("returns a single report by id", async () => {
    const doc = await AnalyticsReport.create({
      account_id: accountId,
      type: "on_demand",
      status: "completed",
      date_range: { start: new Date("2025-06-01"), end: new Date("2025-06-30") },
      report: { executive_summary: "Test report", overall_health: "green" },
    });

    const res = await request(app).get(`/api/analytics/outbound/ai-reports/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.body.report.executive_summary).toBe("Test report");
  });

  it("returns 404 for non-existent report", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app).get(`/api/analytics/outbound/ai-reports/${fakeId}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for report belonging to another account", async () => {
    const doc = await AnalyticsReport.create({
      account_id: otherAccountId,
      type: "on_demand",
      status: "completed",
      date_range: { start: new Date("2025-06-01"), end: new Date("2025-06-30") },
      report: { executive_summary: "Other account" },
    });

    const res = await request(app).get(`/api/analytics/outbound/ai-reports/${doc._id}`);
    expect(res.status).toBe(404);
  });
});

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const EodReport = require("../models/EodReport");
const CampaignLead = require("../models/CampaignLead");
const OutboundLead = require("../models/OutboundLead");
const Campaign = require("../models/Campaign");
const FollowUp = require("../models/FollowUp");

const eodReportsRouter = require("./eod-reports");

let mongoServer;
let app;
const accountId = new mongoose.Types.ObjectId();
const userId = "user123";

function localTodayStr() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = { _id: accountId };
    req.user = { _id: userId, first_name: "Test", last_name: "User", email: "test@test.com" };
    next();
  });
  app.use("/api/eod-reports", eodReportsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await EodReport.deleteMany({});
  await CampaignLead.deleteMany({});
  await OutboundLead.deleteMany({});
  await Campaign.deleteMany({});
  await FollowUp.deleteMany({});
});

describe("GET /api/eod-reports/today", () => {
  it("auto-creates a report for today with default checklist", async () => {
    const res = await request(app).get("/api/eod-reports/today");
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(localTodayStr());
    expect(res.body.checklist).toHaveLength(6);
    expect(res.body.checklist[0].label).toBe("Reviewed pipeline and prioritized follow-ups");
    expect(res.body.checklist[0].checked).toBe(false);
    expect(res.body.stats).toBeDefined();
  });

  it("returns existing report on second call", async () => {
    await request(app).get("/api/eod-reports/today");
    const res = await request(app).get("/api/eod-reports/today");
    expect(res.status).toBe(200);

    const count = await EodReport.countDocuments({ account_id: accountId });
    expect(count).toBe(1);
  });
});

describe("GET /api/eod-reports/today — stats", () => {
  it("calculates stats from today's activity using local timezone", async () => {
    // Create a campaign for this account
    const campaign = await Campaign.create({ account_id: accountId, name: "Test Campaign" });

    // Create activity within today's local time range
    const now = new Date();
    const olId1 = new mongoose.Types.ObjectId();
    const olId2 = new mongoose.Types.ObjectId();
    await CampaignLead.create({
      campaign_id: campaign._id,
      outbound_lead_id: olId1,
      status: "sent",
      sent_at: now,
      username: "lead1",
    });
    await CampaignLead.create({
      campaign_id: campaign._id,
      outbound_lead_id: olId2,
      status: "replied",
      sent_at: now,
      username: "lead2",
    });
    await OutboundLead.create({
      account_id: accountId,
      followingKey: "lead3_key",
      replied_at: now,
      username: "lead3",
    });
    await OutboundLead.create({
      account_id: accountId,
      followingKey: "lead4_key",
      booked_at: now,
      username: "lead4",
    });
    await FollowUp.create({
      account_id: accountId,
      outbound_lead_id: new mongoose.Types.ObjectId(),
      status: "booked",
      updatedAt: now,
    });

    const res = await request(app).get("/api/eod-reports/today");
    expect(res.status).toBe(200);
    expect(res.body.stats.dms_sent).toBe(2);
    expect(res.body.stats.replies_received).toBe(1);
    expect(res.body.stats.bookings_made).toBe(1);
    expect(res.body.stats.follow_ups_completed).toBe(1);
  });

  it("does not count activity from yesterday", async () => {
    const campaign = await Campaign.create({ account_id: accountId, name: "Test Campaign" });

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);

    await CampaignLead.create({
      campaign_id: campaign._id,
      outbound_lead_id: new mongoose.Types.ObjectId(),
      status: "sent",
      sent_at: yesterday,
      username: "old_lead",
    });
    await OutboundLead.create({
      account_id: accountId,
      followingKey: "old_lead2_key",
      replied_at: yesterday,
      username: "old_lead2",
    });

    const res = await request(app).get("/api/eod-reports/today");
    expect(res.status).toBe(200);
    expect(res.body.stats.dms_sent).toBe(0);
    expect(res.body.stats.replies_received).toBe(0);
  });
});

describe("POST /api/eod-reports", () => {
  it("upserts today's report with notes and mood", async () => {
    const res = await request(app)
      .post("/api/eod-reports")
      .send({ notes: "Good day", mood: 4 });

    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("Good day");
    expect(res.body.mood).toBe(4);
  });
});

describe("PATCH /api/eod-reports/:id", () => {
  it("updates checklist and mood", async () => {
    const report = await EodReport.create({
      account_id: accountId,
      user_id: userId,
      user_name: "Test User",
      date: localTodayStr(),
      checklist: [{ label: "Task 1", checked: false }],
    });

    const res = await request(app)
      .patch(`/api/eod-reports/${report._id}`)
      .send({ checklist: [{ label: "Task 1", checked: true }], mood: 5 });

    expect(res.status).toBe(200);
    expect(res.body.checklist[0].checked).toBe(true);
    expect(res.body.mood).toBe(5);
  });

  it("returns 404 for wrong account", async () => {
    const other = new mongoose.Types.ObjectId();
    const report = await EodReport.create({
      account_id: other,
      user_id: userId,
      user_name: "Other",
      date: "2026-01-01",
    });

    const res = await request(app)
      .patch(`/api/eod-reports/${report._id}`)
      .send({ mood: 3 });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/eod-reports", () => {
  it("returns paginated list", async () => {
    await EodReport.create({
      account_id: accountId,
      user_id: userId,
      user_name: "Test User",
      date: "2026-03-18",
    });

    const res = await request(app).get("/api/eod-reports");
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it("filters by date", async () => {
    await EodReport.create({ account_id: accountId, user_id: userId, user_name: "Test", date: "2026-03-18" });
    await EodReport.create({ account_id: accountId, user_id: "other", user_name: "Other", date: "2026-03-17" });

    const res = await request(app).get("/api/eod-reports?date=2026-03-18");
    expect(res.body.reports).toHaveLength(1);
  });
});

describe("GET /api/eod-reports/team", () => {
  it("returns all team reports for a date", async () => {
    await EodReport.create({ account_id: accountId, user_id: "u1", user_name: "User 1", date: "2026-03-18" });
    await EodReport.create({ account_id: accountId, user_id: "u2", user_name: "User 2", date: "2026-03-18" });
    await EodReport.create({ account_id: accountId, user_id: "u1", user_name: "User 1", date: "2026-03-17" });

    const res = await request(app).get("/api/eod-reports/team?date=2026-03-18");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

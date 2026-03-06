const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const OutboundAccount = require("../models/OutboundAccount");
const WarmupLog = require("../models/WarmupLog");
const warmupRouter = require("./warmup");

let mongoServer;
let app;
const accountId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = { _id: accountId, email: "test@test.com" };
    next();
  });
  app.use("/api/warmup", warmupRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await OutboundAccount.deleteMany({});
  await WarmupLog.deleteMany({});
});

describe("GET /api/warmup/:outboundAccountId", () => {
  it("returns disabled state when warmup not started", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "nowarmup" });

    const res = await request(app).get(`/api/warmup/${oa._id}`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.currentDay).toBe(0);
    expect(res.body.schedule).toHaveLength(14);
  });

  it("returns warmup status when active", async () => {
    const startDate = new Date(Date.now() - 10 * 86400000); // 10 days ago
    const oa = await OutboundAccount.create({
      account_id: accountId,
      username: "warming",
      warmup: {
        enabled: true,
        startDate,
        schedule: [
          { day: 11, cap: 12 },
        ],
        checklist: [
          { key: "bio", label: "Complete bio", completed: true, completedAt: new Date() },
          { key: "posts_3", label: "Publish 3 posts", completed: false },
        ],
      },
    });

    const res = await request(app).get(`/api/warmup/${oa._id}`);
    expect(res.body.enabled).toBe(true);
    expect(res.body.currentDay).toBe(11);
    expect(res.body.todayCap).toBe(12);
    expect(res.body.automationBlocked).toBe(false);
    expect(res.body.checklistProgress.completed).toBe(1);
    expect(res.body.checklistProgress.total).toBe(2);
  });

  it("blocks automation in first 8 days", async () => {
    const startDate = new Date(Date.now() - 2 * 86400000); // 2 days ago -> day 3
    const oa = await OutboundAccount.create({
      account_id: accountId,
      username: "early",
      warmup: { enabled: true, startDate, schedule: [], checklist: [] },
    });

    const res = await request(app).get(`/api/warmup/${oa._id}`);
    expect(res.body.automationBlocked).toBe(true);
    expect(res.body.currentDay).toBeLessThan(9);
  });

  it("returns 404 for wrong account", async () => {
    const oa = await OutboundAccount.create({
      account_id: new mongoose.Types.ObjectId(),
      username: "notmine",
    });

    const res = await request(app).get(`/api/warmup/${oa._id}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid id", async () => {
    const res = await request(app).get("/api/warmup/invalid");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/warmup/:outboundAccountId/start", () => {
  it("starts warmup", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "startme" });

    const res = await request(app).post(`/api/warmup/${oa._id}/start`);
    expect(res.status).toBe(200);
    expect(res.body.warmup.enabled).toBe(true);
    expect(res.body.warmup.startDate).toBeTruthy();
    expect(res.body.warmup.schedule).toHaveLength(14);
    expect(res.body.warmup.checklist).toHaveLength(7);
    expect(res.body.status).toBe("warming");

    // Verify log was created
    const logs = await WarmupLog.find({ outbound_account_id: oa._id });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("warmup_started");
  });

  it("returns 400 if warmup already active", async () => {
    const oa = await OutboundAccount.create({
      account_id: accountId,
      username: "alreadywarming",
      warmup: { enabled: true, startDate: new Date() },
    });

    const res = await request(app).post(`/api/warmup/${oa._id}/start`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already active/i);
  });

  it("returns 404 for wrong account", async () => {
    const oa = await OutboundAccount.create({
      account_id: new mongoose.Types.ObjectId(),
      username: "notmine",
    });

    const res = await request(app).post(`/api/warmup/${oa._id}/start`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/warmup/:outboundAccountId/stop", () => {
  it("stops warmup", async () => {
    const oa = await OutboundAccount.create({
      account_id: accountId,
      username: "stopme",
      warmup: { enabled: true, startDate: new Date() },
    });

    const res = await request(app).post(`/api/warmup/${oa._id}/stop`);
    expect(res.status).toBe(200);
    expect(res.body.warmup.enabled).toBe(false);
    expect(res.body.warmup.startDate).toBeNull();

    const logs = await WarmupLog.find({ outbound_account_id: oa._id });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("warmup_stopped");
  });

  it("returns 404 for wrong account", async () => {
    const oa = await OutboundAccount.create({
      account_id: new mongoose.Types.ObjectId(),
      username: "notmine",
    });

    const res = await request(app).post(`/api/warmup/${oa._id}/stop`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/warmup/:outboundAccountId/checklist/:key", () => {
  it("toggles a checklist item on", async () => {
    const oa = await OutboundAccount.create({
      account_id: accountId,
      username: "checklist",
      warmup: {
        enabled: true,
        startDate: new Date(),
        schedule: [],
        checklist: [
          { key: "bio", label: "Complete bio", completed: false },
          { key: "posts_3", label: "Publish 3 posts", completed: false },
        ],
      },
    });

    const res = await request(app).patch(`/api/warmup/${oa._id}/checklist/bio`);
    expect(res.status).toBe(200);

    const item = res.body.warmup.checklist.find((c) => c.key === "bio");
    expect(item.completed).toBe(true);
    expect(item.completedAt).toBeTruthy();

    const logs = await WarmupLog.find({ outbound_account_id: oa._id });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("checklist_toggled");
    expect(logs[0].details.completed).toBe(true);
  });

  it("toggles a checklist item off", async () => {
    const oa = await OutboundAccount.create({
      account_id: accountId,
      username: "toggleoff",
      warmup: {
        enabled: true,
        startDate: new Date(),
        schedule: [],
        checklist: [
          { key: "bio", label: "Complete bio", completed: true, completedAt: new Date() },
        ],
      },
    });

    const res = await request(app).patch(`/api/warmup/${oa._id}/checklist/bio`);
    const item = res.body.warmup.checklist.find((c) => c.key === "bio");
    expect(item.completed).toBe(false);
    expect(item.completedAt).toBeNull();
  });

  it("returns 404 for unknown checklist key", async () => {
    const oa = await OutboundAccount.create({
      account_id: accountId,
      username: "nokey",
      warmup: {
        enabled: true,
        startDate: new Date(),
        schedule: [],
        checklist: [{ key: "bio", label: "Complete bio", completed: false }],
      },
    });

    const res = await request(app).patch(`/api/warmup/${oa._id}/checklist/nonexistent`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/checklist item/i);
  });

  it("returns 404 for checklist key when warmup has no items", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "inactive" });

    const res = await request(app).patch(`/api/warmup/${oa._id}/checklist/bio`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/checklist item/i);
  });
});

describe("GET /api/warmup/:outboundAccountId/logs", () => {
  it("returns warmup logs", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "logged" });
    await WarmupLog.create({
      account_id: accountId,
      outbound_account_id: oa._id,
      action: "warmup_started",
      details: { username: "logged" },
    });
    await WarmupLog.create({
      account_id: accountId,
      outbound_account_id: oa._id,
      action: "checklist_toggled",
      details: { key: "bio", completed: true },
    });

    const res = await request(app).get(`/api/warmup/${oa._id}/logs`);
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
  });

  it("paginates logs", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "paged" });
    for (let i = 0; i < 5; i++) {
      await WarmupLog.create({
        account_id: accountId,
        outbound_account_id: oa._id,
        action: "checklist_toggled",
        details: { key: `item${i}` },
      });
    }

    const res = await request(app).get(`/api/warmup/${oa._id}/logs?page=1&limit=2`);
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.totalPages).toBe(3);
  });

  it("returns 404 for wrong account", async () => {
    const oa = await OutboundAccount.create({
      account_id: new mongoose.Types.ObjectId(),
      username: "notmine",
    });

    const res = await request(app).get(`/api/warmup/${oa._id}/logs`);
    expect(res.status).toBe(404);
  });
});

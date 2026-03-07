const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Task = require("../models/Task");

jest.mock("../utils/logger", () => {
  const noop = () => {};
  const logger = { info: noop, error: noop, warn: noop, debug: noop, child: () => logger };
  return logger;
});

const healthRouter = require("./health");

let mongoServer;
let app;
const accountId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  // health and debug routes don't require auth
  // stats route needs req.account
  app.use((req, _res, next) => {
    req.account = { _id: accountId };
    next();
  });
  app.use("/api", healthRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Task.deleteMany({});
});

describe("GET /api/health", () => {
  it("returns ok status with mongo connected", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.mongo).toBe("connected");
    expect(res.body.timestamp).toBeDefined();
  });
});

describe("GET /api/debug", () => {
  it("returns debug info with default headers", async () => {
    const res = await request(app).get("/api/debug");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.cors).toBe("allowed");
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.userAgent).toBeDefined();
  });

  it("reflects the origin header", async () => {
    const res = await request(app)
      .get("/api/debug")
      .set("Origin", "https://example.com");
    expect(res.body.origin).toBe("https://example.com");
  });
});

describe("GET /api/stats", () => {
  it("returns zeroes when no tasks exist", async () => {
    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.pending).toBe(0);
    expect(res.body.in_progress).toBe(0);
    expect(res.body.completed).toBe(0);
    expect(res.body.failed).toBe(0);
  });

  it("returns aggregated task stats for current account", async () => {
    await Task.create([
      { account_id: accountId, type: "send_dm", target: "user1", status: "pending" },
      { account_id: accountId, type: "send_dm", target: "user2", status: "pending" },
      { account_id: accountId, type: "send_dm", target: "user3", status: "completed" },
      { account_id: accountId, type: "send_dm", target: "user4", status: "failed" },
      { account_id: accountId, type: "send_dm", target: "user5", status: "in_progress" },
    ]);

    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.pending).toBe(2);
    expect(res.body.completed).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.in_progress).toBe(1);
  });

  it("does not count tasks from other accounts", async () => {
    const otherId = new mongoose.Types.ObjectId();
    await Task.create([
      { account_id: accountId, type: "send_dm", target: "mine", status: "pending" },
      { account_id: otherId, type: "send_dm", target: "theirs", status: "pending" },
    ]);

    const res = await request(app).get("/api/stats");
    expect(res.body.total).toBe(1);
    expect(res.body.pending).toBe(1);
  });
});

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const TrendAlert = require("../models/TrendAlert");

jest.mock("../utils/logger", () => {
  const noop = () => {};
  const logger = { info: noop, error: noop, warn: noop, debug: noop, child: () => logger };
  return logger;
});

const alertRouter = require("./youtube-alerts");

let mongoServer;
let app;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use("/alerts", alertRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await TrendAlert.deleteMany({});
});

describe("GET /alerts", () => {
  it("returns empty array when no alerts exist", async () => {
    const res = await request(app).get("/alerts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns alerts sorted by velocity descending", async () => {
    await TrendAlert.create([
      { video_id: "v1", channel_id: "c1", views_per_hour: 100, active: true },
      { video_id: "v2", channel_id: "c1", views_per_hour: 500, active: true },
      { video_id: "v3", channel_id: "c1", views_per_hour: 300, active: true },
    ]);

    const res = await request(app).get("/alerts");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0].views_per_hour).toBe(500);
    expect(res.body[1].views_per_hour).toBe(300);
    expect(res.body[2].views_per_hour).toBe(100);
  });

  it("filters by active status", async () => {
    await TrendAlert.create([
      { video_id: "v1", channel_id: "c1", views_per_hour: 500, active: true },
      { video_id: "v2", channel_id: "c1", views_per_hour: 200, active: false },
    ]);

    const res = await request(app).get("/alerts?active=true");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].video_id).toBe("v1");
  });

  it("respects limit parameter", async () => {
    await TrendAlert.create([
      { video_id: "v1", channel_id: "c1", views_per_hour: 500, active: true },
      { video_id: "v2", channel_id: "c1", views_per_hour: 400, active: true },
      { video_id: "v3", channel_id: "c1", views_per_hour: 300, active: true },
    ]);

    const res = await request(app).get("/alerts?limit=2");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Account = require("../models/Account");
const TrackingEvent = require("../models/TrackingEvent");
const trackingRouter = require("./tracking");

let mongoServer;
let app;
let accountId;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  // Create a real account doc since the route queries Account by ID
  const account = await Account.create({ name: "Test Co", tracking_enabled: true });
  accountId = account._id;

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = { _id: accountId };
    req.user = { role: 1, userId: new mongoose.Types.ObjectId() };
    next();
  });
  app.use("/api/tracking", trackingRouter);
});

afterEach(async () => {
  await Account.deleteMany({});
  await TrackingEvent.deleteMany({});
});

describe("GET /api/tracking/settings", () => {
  it("returns tracking settings", async () => {
    const res = await request(app).get("/api/tracking/settings");
    expect(res.status).toBe(200);
    expect(res.body.tracking_enabled).toBe(true);
    expect(res.body.tracking_conversion_rules).toEqual([]);
  });

  it("returns disabled when tracking is off", async () => {
    await Account.findByIdAndUpdate(accountId, { tracking_enabled: false });

    const res = await request(app).get("/api/tracking/settings");
    expect(res.body.tracking_enabled).toBe(false);
  });
});

describe("PATCH /api/tracking/settings", () => {
  it("enables tracking", async () => {
    await Account.findByIdAndUpdate(accountId, { tracking_enabled: false });

    const res = await request(app)
      .patch("/api/tracking/settings")
      .send({ tracking_enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.tracking_enabled).toBe(true);
  });

  it("sets conversion rules", async () => {
    const res = await request(app)
      .patch("/api/tracking/settings")
      .send({ tracking_conversion_rules: ["/thank-you", "/booking-confirmed"] });

    expect(res.status).toBe(200);
    expect(res.body.tracking_conversion_rules).toHaveLength(2);
    expect(res.body.tracking_conversion_rules).toContain("/thank-you");
  });
});

describe("GET /api/tracking/events", () => {
  it("returns events for current account", async () => {
    await TrackingEvent.create({
      account_id: accountId,
      lead_id: "lead1",
      event_type: "page_view",
      url: "https://example.com",
    });
    await TrackingEvent.create({
      account_id: new mongoose.Types.ObjectId(),
      lead_id: "lead2",
      event_type: "page_view",
    });

    const res = await request(app).get("/api/tracking/events");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await TrackingEvent.create({
        account_id: accountId,
        lead_id: `lead${i}`,
        event_type: "page_view",
      });
    }

    const res = await request(app).get("/api/tracking/events?limit=3");
    expect(res.body.events).toHaveLength(3);
  });
});

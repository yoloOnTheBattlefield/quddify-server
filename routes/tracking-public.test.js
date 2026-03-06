const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Account = require("../models/Account");
const Lead = require("../models/Lead");
const TrackingEvent = require("../models/TrackingEvent");
const trackingPublicRouter = require("./tracking-public");

let mongoServer;
let app;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  // Public routes — no auth middleware
  app.use("/t", trackingPublicRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Account.deleteMany({});
  await Lead.deleteMany({});
  await TrackingEvent.deleteMany({});
});

describe("GET /t/script.js", () => {
  it("returns JavaScript content", async () => {
    const res = await request(app).get("/t/script.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.text).toContain("data-account-id");
  });
});

describe("GET /t/config/:accountId", () => {
  it("returns enabled config for tracked account", async () => {
    const account = await Account.create({
      name: "Tracked",
      tracking_enabled: true,
      tracking_conversion_rules: ["/thank-you"],
    });

    const res = await request(app).get(`/t/config/${account._id}`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.conversion_rules).toContain("/thank-you");
  });

  it("returns disabled for non-tracked account", async () => {
    const account = await Account.create({ name: "Untracked", tracking_enabled: false });

    const res = await request(app).get(`/t/config/${account._id}`);
    expect(res.body.enabled).toBe(false);
  });

  it("returns disabled for invalid account id", async () => {
    const res = await request(app).get("/t/config/invalid");
    expect(res.body.enabled).toBe(false);
  });

  it("returns disabled for nonexistent account", async () => {
    const res = await request(app).get(`/t/config/${new mongoose.Types.ObjectId()}`);
    expect(res.body.enabled).toBe(false);
  });
});

describe("POST /t/event", () => {
  it("stores a page_view event", async () => {
    const account = await Account.create({ name: "Test", tracking_enabled: true });

    const res = await request(app)
      .post("/t/event")
      .send({
        account_id: account._id.toString(),
        lead_id: "lead123",
        event_type: "page_view",
        url: "https://example.com/page",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const events = await TrackingEvent.find({ account_id: account._id });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("page_view");
  });

  it("stores a first_visit event and sets link_clicked_at on lead", async () => {
    const account = await Account.create({ name: "Test", tracking_enabled: true });
    const lead = await Lead.create({
      account_id: account._id.toString(),
      first_name: "Visitor",
      date_created: new Date().toISOString(),
    });

    const res = await request(app)
      .post("/t/event")
      .send({
        account_id: account._id.toString(),
        lead_id: lead._id.toString(),
        event_type: "first_visit",
        url: "https://example.com",
      });

    expect(res.body.ok).toBe(true);

    const updated = await Lead.findById(lead._id);
    expect(updated.link_clicked_at).toBeTruthy();
  });

  it("stores a conversion event and sets booked_at on lead", async () => {
    const account = await Account.create({ name: "Test", tracking_enabled: true });
    const lead = await Lead.create({
      account_id: account._id.toString(),
      first_name: "Converter",
      date_created: new Date().toISOString(),
    });

    const res = await request(app)
      .post("/t/event")
      .send({
        account_id: account._id.toString(),
        lead_id: lead._id.toString(),
        event_type: "conversion",
        url: "https://example.com/thank-you",
      });

    expect(res.body.ok).toBe(true);

    const updated = await Lead.findById(lead._id);
    expect(updated.booked_at).toBeTruthy();
  });

  it("deduplicates first_visit events", async () => {
    const account = await Account.create({ name: "Test", tracking_enabled: true });
    const payload = {
      account_id: account._id.toString(),
      lead_id: "lead_dedup",
      event_type: "first_visit",
      url: "https://example.com",
    };

    await request(app).post("/t/event").send(payload);
    const res = await request(app).post("/t/event").send(payload);

    expect(res.body.deduped).toBe(true);

    const count = await TrackingEvent.countDocuments({
      account_id: account._id,
      lead_id: "lead_dedup",
      event_type: "first_visit",
    });
    expect(count).toBe(1);
  });

  it("deduplicates conversion events", async () => {
    const account = await Account.create({ name: "Test", tracking_enabled: true });
    const payload = {
      account_id: account._id.toString(),
      lead_id: "lead_conv_dedup",
      event_type: "conversion",
    };

    await request(app).post("/t/event").send(payload);
    const res = await request(app).post("/t/event").send(payload);

    expect(res.body.deduped).toBe(true);
  });

  it("allows multiple page_view events (no dedup)", async () => {
    const account = await Account.create({ name: "Test", tracking_enabled: true });
    const payload = {
      account_id: account._id.toString(),
      lead_id: "lead_pv",
      event_type: "page_view",
    };

    await request(app).post("/t/event").send(payload);
    await request(app).post("/t/event").send(payload);

    const count = await TrackingEvent.countDocuments({
      account_id: account._id,
      lead_id: "lead_pv",
      event_type: "page_view",
    });
    expect(count).toBe(2);
  });

  it("returns 400 for missing fields", async () => {
    const res = await request(app)
      .post("/t/event")
      .send({ account_id: new mongoose.Types.ObjectId().toString() });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid event_type", async () => {
    const res = await request(app)
      .post("/t/event")
      .send({
        account_id: new mongoose.Types.ObjectId().toString(),
        lead_id: "lead1",
        event_type: "invalid_type",
      });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid account_id", async () => {
    const res = await request(app)
      .post("/t/event")
      .send({ account_id: "not-valid", lead_id: "lead1", event_type: "page_view" });

    expect(res.status).toBe(400);
  });
});

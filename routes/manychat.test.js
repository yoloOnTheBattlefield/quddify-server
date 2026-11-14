const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Lead = require("../models/Lead");
const manychatRouter = require("./manychat");

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
  app.use("/api/manychat", manychatRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Lead.deleteMany({});
});

describe("POST /api/manychat/webhook", () => {
  it("creates a lead with valid ig_username", async () => {
    const res = await request(app)
      .post("/api/manychat/webhook")
      .send({ ig_username: "testuser", trigger_type: "dm" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.ig_username).toBe("testuser");

    const lead = await Lead.findOne({ ig_username: "testuser" });
    expect(lead).toBeTruthy();
    expect(lead.source).toBe("manychat:dm");
  });

  // Regression: leads were written with the raw GHL location id as account_id,
  // while every read path filters on Account._id.toString() — so they existed
  // in the database but never appeared in the UI.
  it("stores account_id as the CRM ObjectId string, not the GHL location id", async () => {
    await request(app)
      .post("/api/manychat/webhook")
      .send({ ig_username: "visibleuser" });

    const lead = await Lead.findOne({ ig_username: "visibleuser" });
    expect(lead.account_id).toBe(accountId.toString());
  });

  it("strips @ from ig_username", async () => {
    const res = await request(app)
      .post("/api/manychat/webhook")
      .send({ ig_username: "@withatsign" });

    expect(res.status).toBe(200);
    expect(res.body.ig_username).toBe("withatsign");
  });

  it("returns 400 when ig_username is missing", async () => {
    const res = await request(app)
      .post("/api/manychat/webhook")
      .send({ trigger_type: "dm" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation failed/i);
  });

  it("returns 400 when ig_username is empty after sanitizing", async () => {
    const res = await request(app)
      .post("/api/manychat/webhook")
      .send({ ig_username: "@" });

    expect(res.status).toBe(400);
  });

  it("upserts existing lead (does not duplicate)", async () => {
    await request(app)
      .post("/api/manychat/webhook")
      .send({ ig_username: "dupeuser", trigger_type: "dm" });

    await request(app)
      .post("/api/manychat/webhook")
      .send({ ig_username: "dupeuser", trigger_type: "comment" });

    const count = await Lead.countDocuments({ ig_username: "dupeuser" });
    expect(count).toBe(1);

    const lead = await Lead.findOne({ ig_username: "dupeuser" });
    expect(lead.source).toBe("manychat:comment");
  });

  it("parses full_name into first_name and last_name", async () => {
    await request(app)
      .post("/api/manychat/webhook")
      .send({ ig_username: "nameuser", full_name: "John Doe" });

    const lead = await Lead.findOne({ ig_username: "nameuser" });
    expect(lead.first_name).toBe("John");
    expect(lead.last_name).toBe("Doe");
  });

  it("stores post_url when provided", async () => {
    await request(app)
      .post("/api/manychat/webhook")
      .send({ ig_username: "postuser", post_url: "https://instagram.com/p/abc123" });

    const lead = await Lead.findOne({ ig_username: "postuser" });
    expect(lead.post_url).toBe("https://instagram.com/p/abc123");
  });

  it("defaults trigger_type to 'unknown'", async () => {
    await request(app)
      .post("/api/manychat/webhook")
      .send({ ig_username: "notrigger" });

    const lead = await Lead.findOne({ ig_username: "notrigger" });
    expect(lead.source).toBe("manychat:unknown");
  });
});

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

// Models
const Campaign = require("../models/Campaign");
const CampaignLead = require("../models/CampaignLead");
const OutboundLead = require("../models/OutboundLead");
const SenderAccount = require("../models/SenderAccount");

// Route
const manualCampaignsRouter = require("./manual-campaigns");

let mongoServer;
let app;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  // Inject fake account middleware
  app.use((req, _res, next) => {
    req.account = { _id: new mongoose.Types.ObjectId() };
    next();
  });
  app.use("/api/manual-campaigns", manualCampaignsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Campaign.deleteMany({});
  await CampaignLead.deleteMany({});
  await OutboundLead.deleteMany({});
  await SenderAccount.deleteMany({});
});

async function seedCampaign(accountId, overrides = {}) {
  const sender = await SenderAccount.create({
    account_id: accountId,
    ig_username: "va_sender",
    display_name: "VA",
  });

  const campaign = await Campaign.create({
    account_id: accountId,
    name: "Test Manual",
    mode: "manual",
    status: "active",
    messages: ["Hi {{username}}"],
    outbound_account_ids: [],
    last_sent_at: new Date(), // just sent
    ...overrides,
  });

  const outboundLead = await OutboundLead.create({
    account_id: accountId,
    username: "target_user",
    fullName: "Target",
    source: "manual",
  });

  await CampaignLead.create({
    campaign_id: campaign._id,
    outbound_lead_id: outboundLead._id,
    status: "pending",
  });

  return { sender, campaign, outboundLead };
}

describe("GET /api/manual-campaigns/next – skip_wait_time", () => {
  it("returns wait status when skip_wait_time is false and cooldown not elapsed", async () => {
    const accountId = new mongoose.Types.ObjectId();
    // Patch middleware account
    app.use((req, _res, next) => { req.account = { _id: accountId }; next(); });

    const { sender } = await seedCampaign(accountId, {
      schedule: {
        active_hours_start: 0,
        active_hours_end: 23,
        timezone: "UTC",
        min_delay_seconds: 9999,
        max_delay_seconds: 9999,
        skip_wait_time: false,
      },
    });

    const res = await request(app)
      .get(`/api/manual-campaigns/next?sender_id=${sender._id}`)
      .set("Accept", "application/json");

    expect(res.body.status).toBe("wait");
    expect(res.body.wait_seconds).toBeGreaterThan(0);
  });

  it("returns lead immediately when skip_wait_time is true despite recent send", async () => {
    const accountId = new mongoose.Types.ObjectId();
    app.use((req, _res, next) => { req.account = { _id: accountId }; next(); });

    const { sender } = await seedCampaign(accountId, {
      schedule: {
        active_hours_start: 0,
        active_hours_end: 23,
        timezone: "UTC",
        min_delay_seconds: 9999,
        max_delay_seconds: 9999,
        skip_wait_time: true,
      },
    });

    const res = await request(app)
      .get(`/api/manual-campaigns/next?sender_id=${sender._id}`)
      .set("Accept", "application/json");

    expect(res.body.status).toBe("lead");
    expect(res.body.lead.username).toBe("target_user");
  });
});

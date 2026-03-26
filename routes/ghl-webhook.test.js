const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Lead = require("../models/Lead");
const Account = require("../models/Account");
const ghlWebhookRouter = require("./ghl-webhook");

let mongoServer;
let app;
let account;
const ghl = "ghl_test_loc";

// Mock fetch for Telegram calls
const mockFetch = jest.fn(() => Promise.resolve({ ok: true }));
global.fetch = mockFetch;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  account = await Account.create({
    ghl,
    telegram_bot_token: "enc_token",
    telegram_chat_id: "-100123",
  });

  app = express();
  app.use(express.json());
  app.use("/api/ghl", ghlWebhookRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Lead.deleteMany({});
  mockFetch.mockClear();
});

describe("POST /api/ghl/webhook", () => {
  it("returns 400 when contact_id is missing", async () => {
    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({ location: { id: ghl } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contact_id/i);
  });

  it("returns 400 when location.id is missing", async () => {
    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({ contact_id: "c1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location/i);
  });

  it("creates a new lead when contact_id not found", async () => {
    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "John",
        last_name: "Doe",
        contact_id: "ghl_c1",
        date_created: "2026-03-25",
        location: { id: ghl },
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("created");

    const lead = await Lead.findOne({ contact_id: "ghl_c1" });
    expect(lead).toBeTruthy();
    expect(lead.first_name).toBe("John");
    expect(lead.account_id).toBe(ghl);
  });

  it("fires Telegram notification on new lead", async () => {
    await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "Jane",
        contact_id: "ghl_c2",
        date_created: "2026-03-25",
        location: { id: ghl },
      });

    // Telegram sendMessage should have been called
    expect(mockFetch).toHaveBeenCalled();
    const call = mockFetch.mock.calls.find((c) => c[0].includes("telegram"));
    expect(call).toBeTruthy();
  });

  it("updates existing lead with tag", async () => {
    await Lead.create({
      contact_id: "ghl_c3",
      account_id: ghl,
      first_name: "Existing",
      date_created: "2026-03-20",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_c3",
        location: { id: ghl },
        tags: "link_sent",
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("updated");
    expect(res.body.field).toBe("link_sent_at");

    const lead = await Lead.findOne({ contact_id: "ghl_c3" });
    expect(lead.link_sent_at).toBeTruthy();
  });

  it("does not overwrite existing field", async () => {
    await Lead.create({
      contact_id: "ghl_c4",
      account_id: ghl,
      first_name: "Already",
      date_created: "2026-03-20",
      link_sent_at: new Date("2026-03-01"),
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_c4",
        location: { id: ghl },
        tags: "link_sent",
      });

    expect(res.body.action).toBe("already_set");
  });

  it("handles comma-separated tags string", async () => {
    await Lead.create({
      contact_id: "ghl_c5",
      account_id: ghl,
      first_name: "Tags",
      date_created: "2026-03-20",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_c5",
        location: { id: ghl },
        tags: "some_tag, lead_booked",
      });

    expect(res.body.action).toBe("updated");
    expect(res.body.field).toBe("booked_at");
  });

  it("ignores untracked tags", async () => {
    await Lead.create({
      contact_id: "ghl_c6",
      account_id: ghl,
      first_name: "Unknown",
      date_created: "2026-03-20",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_c6",
        location: { id: ghl },
        tags: "random_tag",
      });

    expect(res.body.action).toBe("tag_not_tracked");
  });

  it("returns no_tags when no tags present", async () => {
    await Lead.create({
      contact_id: "ghl_c7",
      account_id: ghl,
      first_name: "NoTags",
      date_created: "2026-03-20",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_c7",
        location: { id: ghl },
      });

    expect(res.body.action).toBe("no_tags");
  });
});

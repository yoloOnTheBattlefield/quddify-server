const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const Account = require("../models/Account");
const calendlyRouter = require("./calendly");

let mongoServer;
let app;
const accountGhl = "test-ghl-id";

// Capture fetch calls
const fetchCalls = [];
const originalFetch = global.fetch;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use("/api/calendly", calendlyRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  global.fetch = originalFetch;
});

beforeEach(() => {
  fetchCalls.length = 0;
  global.fetch = jest.fn(async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, json: async () => ({}) };
  });
});

afterEach(async () => {
  await Lead.deleteMany({});
  await OutboundLead.deleteMany({});
  await Account.deleteMany({});
});

async function createAccount(overrides = {}) {
  return Account.create({
    name: "Test Account",
    ghl: accountGhl,
    ...overrides,
  });
}

function calendlyPayload(overrides = {}) {
  return {
    event: "invitee.created",
    payload: {
      name: "John Doe",
      email: "john@example.com",
      questions_and_answers: [
        { question: "What is your budget?", answer: "$5000" },
      ],
      tracking: {
        utm_source: accountGhl,
        utm_medium: null,
        ...overrides.tracking,
      },
      scheduled_event: "https://api.calendly.com/scheduled_events/abc123",
      ...overrides,
    },
  };
}

describe("POST /api/calendly — Calendly webhook", () => {
  it("ignores non-invitee.created events", async () => {
    const res = await request(app)
      .post("/api/calendly")
      .send({ event: "invitee.canceled", payload: {} });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Event ignored");
  });

  it("returns 400 when account cannot be resolved", async () => {
    const res = await request(app)
      .post("/api/calendly")
      .send(
        calendlyPayload({
          tracking: { utm_source: null, utm_medium: null },
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/resolve account/i);
  });

  describe("Scenario 1: existing inbound lead with contact_id", () => {
    it("updates existing lead by contact_id", async () => {
      await createAccount();
      const lead = await Lead.create({
        first_name: "Jane",
        contact_id: "ghl-contact-123",
        account_id: accountGhl,
        date_created: new Date().toISOString(),
      });

      const res = await request(app)
        .post("/api/calendly")
        .send(
          calendlyPayload({
            tracking: {
              utm_source: accountGhl,
              utm_medium: "ghl-contact-123",
            },
          }),
        );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const updated = await Lead.findById(lead._id);
      expect(updated.booked_at).toBeTruthy();
      expect(updated.email).toBe("john@example.com");
      expect(updated.questions_and_answers).toHaveLength(1);
    });

    it("syncs booked status to linked outbound lead", async () => {
      await createAccount();

      const obLead = await OutboundLead.create({
        account_id: new mongoose.Types.ObjectId(),
        followingKey: "janedoe",
        username: "janedoe",
      });

      await Lead.create({
        first_name: "Jane",
        contact_id: "ghl-contact-456",
        account_id: accountGhl,
        outbound_lead_id: obLead._id,
        date_created: new Date().toISOString(),
      });

      await request(app)
        .post("/api/calendly")
        .send(
          calendlyPayload({
            tracking: {
              utm_source: accountGhl,
              utm_medium: "ghl-contact-456",
            },
          }),
        );

      const updatedOb = await OutboundLead.findById(obLead._id);
      expect(updatedOb.booked).toBe(true);
      expect(updatedOb.booked_at).toBeTruthy();
    });
  });

  describe("Scenario 2: contact_id present but no matching lead", () => {
    it("creates a new lead instead of returning 404", async () => {
      await createAccount();

      const res = await request(app)
        .post("/api/calendly")
        .send(
          calendlyPayload({
            tracking: {
              utm_source: accountGhl,
              utm_medium: "unknown-contact-id",
            },
          }),
        );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const lead = await Lead.findOne({ contact_id: "unknown-contact-id" });
      expect(lead).toBeTruthy();
      expect(lead.source).toBe("calendly");
      expect(lead.first_name).toBe("John");
      expect(lead.last_name).toBe("Doe");
      expect(lead.email).toBe("john@example.com");
      expect(lead.booked_at).toBeTruthy();
      expect(lead.account_id).toBe(accountGhl);
    });
  });

  describe("Scenario 3: standalone booking (no contact_id)", () => {
    it("creates a new lead with source calendly", async () => {
      await createAccount();

      const res = await request(app)
        .post("/api/calendly")
        .send(
          calendlyPayload({
            tracking: { utm_source: accountGhl, utm_medium: null },
          }),
        );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const lead = await Lead.findOne({ email: "john@example.com" });
      expect(lead).toBeTruthy();
      expect(lead.source).toBe("calendly");
      expect(lead.first_name).toBe("John");
      expect(lead.last_name).toBe("Doe");
      expect(lead.booked_at).toBeTruthy();
      expect(lead.date_created).toBeTruthy();
      expect(lead.account_id).toBe(accountGhl);
    });

    it("deduplicates by email on re-booking", async () => {
      await createAccount();

      // First booking
      await request(app)
        .post("/api/calendly")
        .send(
          calendlyPayload({
            tracking: { utm_source: accountGhl, utm_medium: null },
          }),
        );

      // Second booking (same email)
      await request(app)
        .post("/api/calendly")
        .send(
          calendlyPayload({
            tracking: { utm_source: accountGhl, utm_medium: null },
          }),
        );

      const leads = await Lead.find({ email: "john@example.com" });
      expect(leads).toHaveLength(1);
    });
  });

  describe("Account resolution", () => {
    it("resolves account via ?account= query param", async () => {
      await createAccount();

      const res = await request(app)
        .post(`/api/calendly?account=${accountGhl}`)
        .send(
          calendlyPayload({
            tracking: { utm_source: null, utm_medium: null },
          }),
        );

      expect(res.status).toBe(200);
      const lead = await Lead.findOne({ email: "john@example.com" });
      expect(lead).toBeTruthy();
      expect(lead.account_id).toBe(accountGhl);
    });
  });

  describe("GHL webhook", () => {
    it("calls GHL webhook when configured", async () => {
      await createAccount({
        ghl_lead_booked_webhook: "https://ghl.example.com/hook",
      });

      await request(app)
        .post("/api/calendly")
        .send(
          calendlyPayload({
            tracking: { utm_source: accountGhl, utm_medium: null },
          }),
        );

      const ghlCall = fetchCalls.find(
        (c) => c.url === "https://ghl.example.com/hook",
      );
      expect(ghlCall).toBeTruthy();
      expect(ghlCall.opts.method).toBe("POST");

      const body = JSON.parse(ghlCall.opts.body);
      expect(body.email).toBe("john@example.com");
      expect(body.first_name).toBe("John");
      expect(body.last_name).toBe("Doe");
    });

    it("does not call GHL webhook when not configured", async () => {
      await createAccount();

      await request(app)
        .post("/api/calendly")
        .send(
          calendlyPayload({
            tracking: { utm_source: accountGhl, utm_medium: null },
          }),
        );

      const ghlCall = fetchCalls.find(
        (c) => c.url && c.url.includes("ghl"),
      );
      expect(ghlCall).toBeUndefined();
    });
  });
});

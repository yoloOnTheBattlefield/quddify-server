const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Lead = require("../models/Lead");
const leadsRouter = require("./leads");

let mongoServer;
let app;
const accountId = new mongoose.Types.ObjectId();
const ghl = "ghl_test_location";

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = { _id: accountId, ghl };
    req.user = { role: 1, userId: new mongoose.Types.ObjectId() };
    next();
  });
  app.use("/api/leads", leadsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Lead.deleteMany({});
});

function createLead(overrides = {}) {
  return Lead.create({
    account_id: ghl,
    first_name: "Test",
    last_name: "User",
    date_created: new Date().toISOString(),
    ...overrides,
  });
}

describe("GET /api/leads", () => {
  it("returns empty list", async () => {
    const res = await request(app).get("/api/leads");
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("returns leads for current account", async () => {
    await createLead({ first_name: "Mine" });
    await Lead.create({ account_id: "other_ghl", first_name: "Theirs", date_created: new Date().toISOString() });

    const res = await request(app).get("/api/leads");
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].first_name).toBe("Mine");
  });

  it("searches by first_name", async () => {
    await createLead({ first_name: "Alice" });
    await createLead({ first_name: "Bob" });

    const res = await request(app).get("/api/leads?search=Alice");
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].first_name).toBe("Alice");
  });

  it("paginates correctly", async () => {
    for (let i = 0; i < 5; i++) {
      await createLead({ first_name: `User${i}` });
    }

    const res = await request(app).get("/api/leads?page=1&limit=2");
    expect(res.body.leads).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.totalPages).toBe(3);
  });

  it("filters by date range", async () => {
    await createLead({ date_created: "2025-01-15T12:00:00.000Z" });
    await createLead({ date_created: "2025-03-15T12:00:00.000Z" });

    const res = await request(app).get("/api/leads?start_date=2025-03-01&end_date=2025-03-31");
    expect(res.body.leads).toHaveLength(1);
  });

  it("sorts by date_created desc by default", async () => {
    await createLead({ first_name: "Old", date_created: "2025-01-01T00:00:00Z" });
    await createLead({ first_name: "New", date_created: "2025-06-01T00:00:00Z" });

    const res = await request(app).get("/api/leads");
    expect(res.body.leads[0].first_name).toBe("New");
  });
});

describe("POST /api/leads", () => {
  it("creates a lead", async () => {
    const res = await request(app)
      .post("/api/leads")
      .send({ first_name: "Created", account_id: ghl });

    expect(res.status).toBe(201);
    expect(res.body.first_name).toBe("Created");
  });
});

describe("GET /api/leads/:id", () => {
  it("returns a single lead", async () => {
    const lead = await createLead({ first_name: "Single" });

    const res = await request(app).get(`/api/leads/${lead._id}`);
    expect(res.status).toBe(200);
    expect(res.body.first_name).toBe("Single");
  });

  it("returns 404 for nonexistent lead", async () => {
    const res = await request(app).get(`/api/leads/${new mongoose.Types.ObjectId()}`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/leads/:id", () => {
  it("updates a lead", async () => {
    const lead = await createLead({ first_name: "Before" });

    const res = await request(app)
      .patch(`/api/leads/${lead._id}`)
      .send({ first_name: "After" });

    expect(res.status).toBe(200);
    expect(res.body.first_name).toBe("After");
  });
});

describe("DELETE /api/leads/:id", () => {
  it("deletes a lead", async () => {
    const lead = await createLead();

    const res = await request(app).delete(`/api/leads/${lead._id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const found = await Lead.findById(lead._id);
    expect(found).toBeNull();
  });
});

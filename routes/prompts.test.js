const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Prompt = require("../models/Prompt");
const promptsRouter = require("./prompts");

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
  app.use("/api/prompts", promptsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Prompt.deleteMany({});
});

describe("GET /api/prompts", () => {
  it("returns empty list", async () => {
    const res = await request(app).get("/api/prompts");
    expect(res.status).toBe(200);
    expect(res.body.prompts).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("returns prompts for current account only", async () => {
    await Prompt.create({ account_id: accountId, label: "Mine", promptText: "text" });
    await Prompt.create({ account_id: new mongoose.Types.ObjectId(), label: "Theirs", promptText: "text" });

    const res = await request(app).get("/api/prompts");
    expect(res.body.prompts).toHaveLength(1);
    expect(res.body.prompts[0].label).toBe("Mine");
  });

  it("searches by label", async () => {
    await Prompt.create({ account_id: accountId, label: "DM Opener", promptText: "text" });
    await Prompt.create({ account_id: accountId, label: "Follow-up", promptText: "text" });

    const res = await request(app).get("/api/prompts?search=opener");
    expect(res.body.prompts).toHaveLength(1);
    expect(res.body.prompts[0].label).toBe("DM Opener");
  });

  it("paginates results", async () => {
    for (let i = 0; i < 5; i++) {
      await Prompt.create({ account_id: accountId, label: `Prompt ${i}`, promptText: "text" });
    }

    const res = await request(app).get("/api/prompts?page=1&limit=2");
    expect(res.body.prompts).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.totalPages).toBe(3);
  });
});

describe("GET /api/prompts/:id", () => {
  it("returns a single prompt", async () => {
    const p = await Prompt.create({ account_id: accountId, label: "Single", promptText: "text" });

    const res = await request(app).get(`/api/prompts/${p._id}`);
    expect(res.status).toBe(200);
    expect(res.body.label).toBe("Single");
  });

  it("returns 404 for nonexistent prompt", async () => {
    const res = await request(app).get(`/api/prompts/${new mongoose.Types.ObjectId()}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/prompts", () => {
  it("creates a prompt", async () => {
    const res = await request(app)
      .post("/api/prompts")
      .send({ label: "New Prompt", promptText: "Qualify this lead: {{bio}}" });

    expect(res.status).toBe(201);
    expect(res.body.label).toBe("New Prompt");
    expect(res.body.isDefault).toBe(false);
  });

  it("returns 400 for missing label", async () => {
    const res = await request(app)
      .post("/api/prompts")
      .send({ promptText: "text" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for missing promptText", async () => {
    const res = await request(app)
      .post("/api/prompts")
      .send({ label: "No Text" });

    expect(res.status).toBe(400);
  });

  it("unsets other defaults when creating a default prompt", async () => {
    const existing = await Prompt.create({
      account_id: accountId,
      label: "Old Default",
      promptText: "text",
      isDefault: true,
    });

    await request(app)
      .post("/api/prompts")
      .send({ label: "New Default", promptText: "text", isDefault: true });

    const updated = await Prompt.findById(existing._id).lean();
    expect(updated.isDefault).toBe(false);
  });

  it("saves filters when provided", async () => {
    const res = await request(app)
      .post("/api/prompts")
      .send({
        label: "Filtered",
        promptText: "text",
        filters: { minFollowers: 10000, verifiedOnly: true },
      });

    expect(res.status).toBe(201);
    expect(res.body.filters.minFollowers).toBe(10000);
    expect(res.body.filters.verifiedOnly).toBe(true);
  });
});

describe("PATCH /api/prompts/:id", () => {
  it("updates a prompt", async () => {
    const p = await Prompt.create({ account_id: accountId, label: "Before", promptText: "old" });

    const res = await request(app)
      .patch(`/api/prompts/${p._id}`)
      .send({ label: "After", promptText: "new" });

    expect(res.status).toBe(200);
    expect(res.body.label).toBe("After");
    expect(res.body.promptText).toBe("new");
  });

  it("unsets other defaults when setting isDefault", async () => {
    const p1 = await Prompt.create({ account_id: accountId, label: "P1", promptText: "t", isDefault: true });
    const p2 = await Prompt.create({ account_id: accountId, label: "P2", promptText: "t", isDefault: false });

    await request(app)
      .patch(`/api/prompts/${p2._id}`)
      .send({ isDefault: true });

    const updated = await Prompt.findById(p1._id).lean();
    expect(updated.isDefault).toBe(false);
  });

  it("returns 404 for nonexistent prompt", async () => {
    const res = await request(app)
      .patch(`/api/prompts/${new mongoose.Types.ObjectId()}`)
      .send({ label: "Nope" });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/prompts/:id", () => {
  it("deletes a prompt", async () => {
    const p = await Prompt.create({ account_id: accountId, label: "Delete Me", promptText: "text" });

    const res = await request(app).delete(`/api/prompts/${p._id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const found = await Prompt.findById(p._id);
    expect(found).toBeNull();
  });
});

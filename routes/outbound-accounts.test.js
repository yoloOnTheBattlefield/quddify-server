const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const OutboundAccount = require("../models/OutboundAccount");
const SenderAccount = require("../models/SenderAccount");

// Mock socketManager to avoid real socket emissions
jest.mock("../services/socketManager", () => ({
  emitToAccount: jest.fn(),
}));

const outboundAccountsRouter = require("./outbound-accounts");

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
  app.use("/api/outbound-accounts", outboundAccountsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await OutboundAccount.deleteMany({});
  await SenderAccount.deleteMany({});
});

describe("GET /api/outbound-accounts", () => {
  it("returns empty list", async () => {
    const res = await request(app).get("/api/outbound-accounts");
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("returns accounts for this tenant only", async () => {
    await OutboundAccount.create({ account_id: accountId, username: "mine" });
    await OutboundAccount.create({ account_id: new mongoose.Types.ObjectId(), username: "theirs" });

    const res = await request(app).get("/api/outbound-accounts");
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].username).toBe("mine");
  });

  it("filters by status", async () => {
    await OutboundAccount.create({ account_id: accountId, username: "a1", status: "ready" });
    await OutboundAccount.create({ account_id: accountId, username: "a2", status: "new" });

    const res = await request(app).get("/api/outbound-accounts?status=ready");
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].username).toBe("a1");
  });

  it("searches by username", async () => {
    await OutboundAccount.create({ account_id: accountId, username: "findme" });
    await OutboundAccount.create({ account_id: accountId, username: "other" });

    const res = await request(app).get("/api/outbound-accounts?search=findme");
    expect(res.body.accounts).toHaveLength(1);
  });

  it("paginates results", async () => {
    for (let i = 0; i < 5; i++) {
      await OutboundAccount.create({ account_id: accountId, username: `user${i}` });
    }

    const res = await request(app).get("/api/outbound-accounts?page=1&limit=2");
    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.totalPages).toBe(3);
  });

  it("enriches with linked sender status", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "linked" });
    await SenderAccount.create({
      account_id: accountId,
      outbound_account_id: oa._id,
      ig_username: "linked",
      status: "online",
    });

    const res = await request(app).get("/api/outbound-accounts");
    expect(res.body.accounts[0].linked_sender_status).toBe("online");
  });
});

describe("POST /api/outbound-accounts", () => {
  it("creates an account", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts")
      .send({ username: "@TestUser" });

    expect(res.status).toBe(201);
    expect(res.body.username).toBe("testuser"); // cleaned
  });

  it("returns 400 for missing username", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts")
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 409 for duplicate username", async () => {
    await OutboundAccount.create({ account_id: accountId, username: "taken" });

    const res = await request(app)
      .post("/api/outbound-accounts")
      .send({ username: "taken" });

    expect(res.status).toBe(409);
  });
});

describe("GET /api/outbound-accounts/:id", () => {
  it("returns a single account", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "single" });

    const res = await request(app).get(`/api/outbound-accounts/${oa._id}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("single");
  });

  it("returns 404 for wrong account", async () => {
    const oa = await OutboundAccount.create({
      account_id: new mongoose.Types.ObjectId(),
      username: "notmine",
    });

    const res = await request(app).get(`/api/outbound-accounts/${oa._id}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid id", async () => {
    const res = await request(app).get("/api/outbound-accounts/invalid");
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/outbound-accounts/:id", () => {
  it("updates allowed fields", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "patchme" });

    const res = await request(app)
      .patch(`/api/outbound-accounts/${oa._id}`)
      .send({ status: "ready", notes: "test note" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.notes).toBe("test note");
  });

  it("cleans username on update", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "old" });

    const res = await request(app)
      .patch(`/api/outbound-accounts/${oa._id}`)
      .send({ username: "@NewName" });

    expect(res.body.username).toBe("newname");
  });

  it("returns 400 when no valid fields provided", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "nofields" });

    const res = await request(app)
      .patch(`/api/outbound-accounts/${oa._id}`)
      .send({ randomField: "value" });

    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/outbound-accounts/:id", () => {
  it("deletes an account", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "deleteme" });

    const res = await request(app).delete(`/api/outbound-accounts/${oa._id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const found = await OutboundAccount.findById(oa._id);
    expect(found).toBeNull();
  });

  it("returns 404 for wrong account", async () => {
    const oa = await OutboundAccount.create({
      account_id: new mongoose.Types.ObjectId(),
      username: "notmine",
    });

    const res = await request(app).delete(`/api/outbound-accounts/${oa._id}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/outbound-accounts/:id/token", () => {
  it("generates a browser token", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "tokenuser" });

    const res = await request(app).post(`/api/outbound-accounts/${oa._id}/token`);
    expect(res.status).toBe(200);
    expect(res.body.browser_token).toMatch(/^oat_/);
  });
});

describe("DELETE /api/outbound-accounts/:id/token", () => {
  it("revokes browser token", async () => {
    const oa = await OutboundAccount.create({
      account_id: accountId,
      username: "revokeuser",
      browser_token: "oat_old",
    });

    const res = await request(app).delete(`/api/outbound-accounts/${oa._id}/token`);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);

    const updated = await OutboundAccount.findById(oa._id);
    expect(updated.browser_token).toBeNull();
  });
});

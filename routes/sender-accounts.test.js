const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const SenderAccount = require("../models/SenderAccount");
const OutboundAccount = require("../models/OutboundAccount");
const Task = require("../models/Task");
const senderAccountsRouter = require("./sender-accounts");

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
  app.use("/api/sender-accounts", senderAccountsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await SenderAccount.deleteMany({});
  await OutboundAccount.deleteMany({});
  await Task.deleteMany({});
});

describe("GET /api/sender-accounts", () => {
  it("returns empty list", async () => {
    const res = await request(app).get("/api/sender-accounts");
    expect(res.status).toBe(200);
    expect(res.body.senders).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("returns senders for this tenant only", async () => {
    await SenderAccount.create({ account_id: accountId, ig_username: "mine" });
    await SenderAccount.create({ account_id: new mongoose.Types.ObjectId(), ig_username: "theirs" });

    const res = await request(app).get("/api/sender-accounts");
    expect(res.body.senders).toHaveLength(1);
    expect(res.body.senders[0].ig_username).toBe("mine");
  });

  it("filters by status", async () => {
    await SenderAccount.create({ account_id: accountId, ig_username: "on1", status: "online" });
    await SenderAccount.create({ account_id: accountId, ig_username: "off1", status: "offline" });

    const res = await request(app).get("/api/sender-accounts?status=online");
    expect(res.body.senders).toHaveLength(1);
    expect(res.body.senders[0].ig_username).toBe("on1");
  });

  it("searches by ig_username", async () => {
    await SenderAccount.create({ account_id: accountId, ig_username: "findme" });
    await SenderAccount.create({ account_id: accountId, ig_username: "other" });

    const res = await request(app).get("/api/sender-accounts?search=findme");
    expect(res.body.senders).toHaveLength(1);
  });

  it("paginates results", async () => {
    for (let i = 0; i < 5; i++) {
      await SenderAccount.create({ account_id: accountId, ig_username: `sender${i}` });
    }

    const res = await request(app).get("/api/sender-accounts?page=1&limit=2");
    expect(res.body.senders).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.totalPages).toBe(3);
  });

  it("enriches with upcoming task", async () => {
    const sender = await SenderAccount.create({ account_id: accountId, ig_username: "tasked" });
    await Task.create({
      account_id: accountId,
      sender_id: sender._id,
      type: "send_dm",
      target: "someone",
      status: "pending",
    });

    const res = await request(app).get("/api/sender-accounts");
    expect(res.body.senders[0].upcomingTask).toBeTruthy();
    expect(res.body.senders[0].upcomingTask.target).toBe("someone");
  });

  it("enriches with outbound account info", async () => {
    const oa = await OutboundAccount.create({ account_id: accountId, username: "linked" });
    await SenderAccount.create({ account_id: accountId, ig_username: "linked", outbound_account_id: oa._id });

    const res = await request(app).get("/api/sender-accounts");
    expect(res.body.senders[0].link_status).toBe("linked");
    expect(res.body.senders[0].outbound_account.username).toBe("linked");
  });

  it("shows not_linked when no outbound account", async () => {
    await SenderAccount.create({ account_id: accountId, ig_username: "solo" });

    const res = await request(app).get("/api/sender-accounts");
    expect(res.body.senders[0].link_status).toBe("not_linked");
    expect(res.body.senders[0].outbound_account).toBeNull();
  });
});

describe("POST /api/sender-accounts", () => {
  it("creates a sender", async () => {
    const res = await request(app)
      .post("/api/sender-accounts")
      .send({ ig_username: "@TestSender" });

    expect(res.status).toBe(201);
    expect(res.body.ig_username).toBe("testsender");
    expect(res.body.status).toBe("offline");
  });

  it("returns 400 for missing ig_username", async () => {
    const res = await request(app)
      .post("/api/sender-accounts")
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 409 for duplicate ig_username", async () => {
    await SenderAccount.create({ account_id: accountId, ig_username: "taken" });

    const res = await request(app)
      .post("/api/sender-accounts")
      .send({ ig_username: "taken" });

    expect(res.status).toBe(409);
  });
});

describe("POST /api/sender-accounts/heartbeat", () => {
  it("updates sender status to online", async () => {
    const sender = await SenderAccount.create({ account_id: accountId, ig_username: "heartbeat" });

    const res = await request(app)
      .post("/api/sender-accounts/heartbeat")
      .send({ sender_id: sender._id.toString() });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const updated = await SenderAccount.findById(sender._id);
    expect(updated.status).toBe("online");
    expect(updated.last_seen).toBeTruthy();
  });

  it("returns 400 for invalid sender_id", async () => {
    const res = await request(app)
      .post("/api/sender-accounts/heartbeat")
      .send({ sender_id: "invalid" });

    expect(res.status).toBe(400);
  });

  it("returns 404 for wrong account", async () => {
    const sender = await SenderAccount.create({
      account_id: new mongoose.Types.ObjectId(),
      ig_username: "notmine",
    });

    const res = await request(app)
      .post("/api/sender-accounts/heartbeat")
      .send({ sender_id: sender._id.toString() });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/sender-accounts/:id", () => {
  it("returns a single sender", async () => {
    const sender = await SenderAccount.create({ account_id: accountId, ig_username: "single" });

    const res = await request(app).get(`/api/sender-accounts/${sender._id}`);
    expect(res.status).toBe(200);
    expect(res.body.ig_username).toBe("single");
  });

  it("returns 404 for wrong account", async () => {
    const sender = await SenderAccount.create({
      account_id: new mongoose.Types.ObjectId(),
      ig_username: "notmine",
    });

    const res = await request(app).get(`/api/sender-accounts/${sender._id}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid id", async () => {
    const res = await request(app).get("/api/sender-accounts/invalid");
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/sender-accounts/:id", () => {
  it("updates display_name", async () => {
    const sender = await SenderAccount.create({ account_id: accountId, ig_username: "patchme" });

    const res = await request(app)
      .patch(`/api/sender-accounts/${sender._id}`)
      .send({ display_name: "New Name" });

    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe("New Name");
  });

  it("updates daily_limit", async () => {
    const sender = await SenderAccount.create({ account_id: accountId, ig_username: "limitme" });

    const res = await request(app)
      .patch(`/api/sender-accounts/${sender._id}`)
      .send({ daily_limit: 100 });

    expect(res.status).toBe(200);
    expect(res.body.daily_limit).toBe(100);
  });

  it("returns 400 when no valid fields", async () => {
    const sender = await SenderAccount.create({ account_id: accountId, ig_username: "nofields" });

    const res = await request(app)
      .patch(`/api/sender-accounts/${sender._id}`)
      .send({ randomField: "value" });

    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/sender-accounts/:id", () => {
  it("deletes a sender", async () => {
    const sender = await SenderAccount.create({ account_id: accountId, ig_username: "deleteme" });

    const res = await request(app).delete(`/api/sender-accounts/${sender._id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const found = await SenderAccount.findById(sender._id);
    expect(found).toBeNull();
  });

  it("returns 404 for wrong account", async () => {
    const sender = await SenderAccount.create({
      account_id: new mongoose.Types.ObjectId(),
      ig_username: "notmine",
    });

    const res = await request(app).delete(`/api/sender-accounts/${sender._id}`);
    expect(res.status).toBe(404);
  });
});

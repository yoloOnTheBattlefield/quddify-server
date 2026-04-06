const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const bcrypt = require("bcryptjs");

// The clients router eagerly requires the niche playbook generator service,
// which pulls in AI SDKs that don't need to run during unit tests. Stub it
// before the router is loaded.
jest.mock("../services/carousel/nichePlaybookGenerator", () => ({
  generateNichePlaybook: jest.fn().mockResolvedValue(undefined),
}));

const Account = require("../models/Account");
const User = require("../models/User");
const AccountUser = require("../models/AccountUser");
const Client = require("../models/Client");
const clientsRouter = require("./clients");

let mongoServer;
let app;
let creatorAccountId;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = { _id: creatorAccountId };
    req.user = { userId: new mongoose.Types.ObjectId(), role: 1 };
    next();
  });
  app.use("/api/clients", clientsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const creator = await Account.create({ name: "Creator Agency" });
  creatorAccountId = creator._id;
});

afterEach(async () => {
  await Account.deleteMany({});
  await User.deleteMany({});
  await AccountUser.deleteMany({});
  await Client.deleteMany({});
});

describe("POST /api/clients — client user isolation", () => {
  it("puts the Client document in the creator's account", async () => {
    const res = await request(app).post("/api/clients").send({
      name: "Hayk Coaching",
      email: "hayk@example.com",
      password: "password123",
      niche: "fitness",
    });

    expect(res.status).toBe(201);
    const client = await Client.findById(res.body._id);
    expect(String(client.account_id)).toBe(String(creatorAccountId));
  });

  it("provisions a NEW account for the client user, not the creator's", async () => {
    await request(app).post("/api/clients").send({
      name: "Hayk Coaching",
      email: "hayk@example.com",
      password: "password123",
    });

    const user = await User.findOne({ email: "hayk@example.com" });
    expect(user).toBeTruthy();
    // User.account_id must NOT be the creator's account.
    expect(String(user.account_id)).not.toBe(String(creatorAccountId));

    // The user's Account must actually exist and be distinct.
    const clientAccount = await Account.findById(user.account_id);
    expect(clientAccount).toBeTruthy();
    expect(String(clientAccount._id)).not.toBe(String(creatorAccountId));
  });

  it("binds AccountUser to the new isolated account (not the creator's)", async () => {
    await request(app).post("/api/clients").send({
      name: "Hayk Coaching",
      email: "hayk@example.com",
      password: "password123",
    });

    const user = await User.findOne({ email: "hayk@example.com" });
    const memberships = await AccountUser.find({ user_id: user._id });

    expect(memberships).toHaveLength(1);
    // Must NOT be a member of the creator's account — that is the whole bug.
    expect(String(memberships[0].account_id)).not.toBe(String(creatorAccountId));
    expect(String(memberships[0].account_id)).toBe(String(user.account_id));
    expect(memberships[0].is_default).toBe(true);
  });

  it("does NOT provision an account when no credentials are supplied", async () => {
    const beforeCount = await Account.countDocuments();

    const res = await request(app).post("/api/clients").send({
      name: "Managed Only",
      niche: "fitness",
    });

    expect(res.status).toBe(201);
    const afterCount = await Account.countDocuments();
    expect(afterCount).toBe(beforeCount); // no extra account created
    expect(await User.countDocuments()).toBe(0);
    expect(await AccountUser.countDocuments()).toBe(0);
  });

  it("rejects duplicate user emails", async () => {
    await User.create({
      email: "dupe@example.com",
      password: await bcrypt.hash("password123", 10),
      account_id: creatorAccountId,
    });

    const res = await request(app).post("/api/clients").send({
      name: "Dupe Client",
      email: "dupe@example.com",
      password: "password123",
    });

    expect(res.status).toBe(409);
  });
});

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const Invitation = require("../models/Invitation");
const User = require("../models/User");
const Account = require("../models/Account");
const AccountUser = require("../models/AccountUser");

// Mock auth middleware to inject user without JWT verification
jest.mock("../middleware/auth", () => {
  const original = jest.requireActual("../middleware/auth");
  return {
    ...original,
    auth: (req, _res, next) => {
      // Use the pre-set req.user and req.account from test setup
      next();
    },
  };
});

const invitationRouter = require("./invitations");

// Mock Resend
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn().mockResolvedValue({ id: "mock-email-id" }),
    },
  })),
}));

let mongoServer;
let app;
const adminUserId = new mongoose.Types.ObjectId();
const accountId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  // App with admin auth for POST /
  app = express();
  app.use(express.json());
  app.use("/api/invitations", invitationRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Invitation.deleteMany({});
  await User.deleteMany({});
  await Account.deleteMany({});
  await AccountUser.deleteMany({});
});

function createTestApp(role = 0) {
  const testApp = express();
  testApp.use(express.json());
  // The invitations router applies auth internally on POST /
  // For testing, we override auth middleware behavior
  testApp.use((req, _res, next) => {
    req.account = { _id: accountId };
    req.user = { userId: adminUserId, accountId, role };
    next();
  });
  testApp.use("/api/invitations", invitationRouter);
  return testApp;
}

describe("POST /api/invitations", () => {
  it("creates a client invitation and returns invitation data", async () => {
    const adminApp = createTestApp(0);
    const res = await request(adminApp).post("/api/invitations").send({
      email: "newclient@test.com",
      first_name: "New",
      last_name: "Client",
      type: "client",
      ghl: "ghl123",
    });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe("newclient@test.com");
    expect(res.body.type).toBe("client");
    expect(res.body.status).toBe("pending");

    const invitation = await Invitation.findById(res.body._id);
    expect(invitation).toBeTruthy();
    expect(invitation.token).toBeDefined();
  });

  it("creates a team member invitation", async () => {
    const adminApp = createTestApp(0);
    const account = await Account.create({ name: "Test Co", ghl: "ghl1" });

    const res = await request(adminApp).post("/api/invitations").send({
      email: "member@test.com",
      first_name: "Team",
      last_name: "Member",
      type: "team_member",
      account_id: account._id.toString(),
      has_outbound: true,
    });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("team_member");
  });

  it("returns 409 when client email already exists", async () => {
    const adminApp = createTestApp(0);
    await User.create({
      email: "exists@test.com",
      password: await bcrypt.hash("pass123", 10),
      account_id: accountId,
    });

    const res = await request(adminApp).post("/api/invitations").send({
      email: "exists@test.com",
      type: "client",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("returns 400 when team member invite missing account_id", async () => {
    const adminApp = createTestApp(0);
    const res = await request(adminApp).post("/api/invitations").send({
      email: "member@test.com",
      type: "team_member",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/account_id/i);
  });
});

describe("GET /api/invitations/:token", () => {
  it("returns invitation info for valid token", async () => {
    const token = crypto.randomBytes(32).toString("hex");
    await Invitation.create({
      email: "invite@test.com",
      first_name: "Test",
      last_name: "User",
      token,
      type: "client",
      status: "pending",
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    // Use the main app (no auth needed)
    const res = await request(app).get(`/api/invitations/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("invite@test.com");
    expect(res.body.first_name).toBe("Test");
    expect(res.body.type).toBe("client");
  });

  it("returns 404 for expired invitation", async () => {
    const token = crypto.randomBytes(32).toString("hex");
    await Invitation.create({
      email: "expired@test.com",
      token,
      type: "client",
      status: "pending",
      expires_at: new Date(Date.now() - 1000),
    });

    const res = await request(app).get(`/api/invitations/${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for already accepted invitation", async () => {
    const token = crypto.randomBytes(32).toString("hex");
    await Invitation.create({
      email: "accepted@test.com",
      token,
      type: "client",
      status: "accepted",
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const res = await request(app).get(`/api/invitations/${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for non-existent token", async () => {
    const res = await request(app).get("/api/invitations/nonexistent123");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/invitations/:token/accept", () => {
  it("accepts a client invitation and creates account + user", async () => {
    const token = crypto.randomBytes(32).toString("hex");
    await Invitation.create({
      email: "newclient@test.com",
      first_name: "New",
      last_name: "Client",
      token,
      type: "client",
      ghl: "ghl-abc",
      status: "pending",
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .post(`/api/invitations/${token}/accept`)
      .send({ password: "securepass123" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe("newclient@test.com");
    expect(res.body.account.ghl).toBe("ghl-abc");

    // Verify DB records
    const user = await User.findOne({ email: "newclient@test.com" });
    expect(user).toBeTruthy();
    const account = await Account.findById(res.body.account._id);
    expect(account).toBeTruthy();
    const membership = await AccountUser.findOne({ user_id: user._id });
    expect(membership).toBeTruthy();
    expect(membership.is_default).toBe(true);

    // Verify invitation status
    const inv = await Invitation.findOne({ token });
    expect(inv.status).toBe("accepted");
  });

  it("accepts a team member invitation", async () => {
    const account = await Account.create({ name: "Existing Co", ghl: "ghl1" });
    const token = crypto.randomBytes(32).toString("hex");
    await Invitation.create({
      email: "teammember@test.com",
      first_name: "Team",
      last_name: "Member",
      token,
      type: "team_member",
      account_id: account._id,
      role: 2,
      has_outbound: true,
      has_research: true,
      status: "pending",
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .post(`/api/invitations/${token}/accept`)
      .send({ password: "securepass123" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe("teammember@test.com");

    const membership = await AccountUser.findOne({
      account_id: account._id,
      user_id: res.body.user._id,
    });
    expect(membership).toBeTruthy();
    expect(membership.has_outbound).toBe(true);
  });

  it("returns 400 for short password", async () => {
    const token = crypto.randomBytes(32).toString("hex");
    await Invitation.create({
      email: "test@test.com",
      token,
      type: "client",
      status: "pending",
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .post(`/api/invitations/${token}/accept`)
      .send({ password: "123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 6/i);
  });

  it("returns 404 for expired invitation", async () => {
    const token = crypto.randomBytes(32).toString("hex");
    await Invitation.create({
      email: "test@test.com",
      token,
      type: "client",
      status: "pending",
      expires_at: new Date(Date.now() - 1000),
    });

    const res = await request(app)
      .post(`/api/invitations/${token}/accept`)
      .send({ password: "password123" });

    expect(res.status).toBe(404);
  });
});

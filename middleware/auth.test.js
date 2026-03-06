const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const Account = require("../models/Account");
const AccountUser = require("../models/AccountUser");
const OutboundAccount = require("../models/OutboundAccount");
const { auth, generateToken, generateSelectionToken, JWT_SECRET } = require("./auth");

let mongoServer;
let app;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use(auth);
  app.get("/test", (req, res) => {
    res.json({ account: req.account?._id, user: req.user });
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Account.deleteMany({});
  await AccountUser.deleteMany({});
  await OutboundAccount.deleteMany({});
});

describe("auth middleware", () => {
  it("returns 401 when no token provided", async () => {
    const res = await request(app).get("/test");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing/i);
  });

  it("returns 401 for invalid JWT", async () => {
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer invalid.token.here");
    expect(res.status).toBe(401);
  });

  it("authenticates with valid JWT", async () => {
    const account = await Account.create({ name: "Test Account" });
    const userId = new mongoose.Types.ObjectId();
    await AccountUser.create({
      user_id: userId,
      account_id: account._id,
      role: 1,
    });

    const token = jwt.sign(
      { userId, accountId: account._id, role: 1 },
      JWT_SECRET,
      { expiresIn: "1h" },
    );

    const res = await request(app)
      .get("/test")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.account).toBe(account._id.toString());
  });

  it("returns 401 for expired JWT", async () => {
    const token = jwt.sign(
      { userId: new mongoose.Types.ObjectId(), accountId: new mongoose.Types.ObjectId() },
      JWT_SECRET,
      { expiresIn: "0s" },
    );

    const res = await request(app)
      .get("/test")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired|invalid/i);
  });

  it("authenticates with valid API key (qd_ prefix)", async () => {
    const account = await Account.create({
      name: "API Account",
      api_key: "qd_testkey123",
    });

    const res = await request(app)
      .get("/test")
      .set("x-api-key", "qd_testkey123");
    expect(res.status).toBe(200);
    expect(res.body.account).toBe(account._id.toString());
  });

  it("returns 401 for invalid API key", async () => {
    const res = await request(app)
      .get("/test")
      .set("x-api-key", "qd_nonexistent");
    expect(res.status).toBe(401);
  });

  it("returns 403 for disabled account via API key", async () => {
    await Account.create({
      name: "Disabled",
      api_key: "qd_disabled",
      disabled: true,
    });

    const res = await request(app)
      .get("/test")
      .set("x-api-key", "qd_disabled");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it("returns 403 for deleted account via API key", async () => {
    await Account.create({
      name: "Deleted",
      api_key: "qd_deleted",
      deleted: true,
    });

    const res = await request(app)
      .get("/test")
      .set("x-api-key", "qd_deleted");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/deleted/i);
  });

  it("authenticates with browser token (oat_ prefix)", async () => {
    const account = await Account.create({ name: "Browser Account" });
    await OutboundAccount.create({
      account_id: account._id,
      username: "test_ig",
      browser_token: "oat_testbrowser",
    });

    const res = await request(app)
      .get("/test")
      .set("x-api-key", "oat_testbrowser");
    expect(res.status).toBe(200);
    expect(res.body.account).toBe(account._id.toString());
  });

  it("returns 401 for invalid browser token", async () => {
    const res = await request(app)
      .get("/test")
      .set("x-api-key", "oat_nonexistent");
    expect(res.status).toBe(401);
  });

  it("returns 403 when user is no longer a member", async () => {
    const account = await Account.create({ name: "No Member Account" });
    const userId = new mongoose.Types.ObjectId();
    // No AccountUser record created

    const token = jwt.sign(
      { userId, accountId: account._id, role: 1 },
      JWT_SECRET,
      { expiresIn: "1h" },
    );

    const res = await request(app)
      .get("/test")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no longer a member/i);
  });
});

describe("generateToken", () => {
  it("creates a JWT with expected claims", () => {
    const user = { _id: "user123" };
    const account = { _id: "acc456", ghl: "ghl789", has_outbound: true, has_research: false };
    const accountUser = { role: 1, has_outbound: true, has_research: true };

    const token = generateToken(user, account, accountUser);
    const decoded = jwt.verify(token, JWT_SECRET);

    expect(decoded.userId).toBe("user123");
    expect(decoded.accountId).toBe("acc456");
    expect(decoded.ghl).toBe("ghl789");
    expect(decoded.role).toBe(1);
    expect(decoded.has_outbound).toBe(true);
    expect(decoded.has_research).toBe(false); // account.has_research is false
  });
});

describe("generateSelectionToken", () => {
  it("creates a short-lived token with purpose claim", () => {
    const user = { _id: "user123" };
    const token = generateSelectionToken(user);
    const decoded = jwt.verify(token, JWT_SECRET);

    expect(decoded.userId).toBe("user123");
    expect(decoded.purpose).toBe("account_selection");
  });
});

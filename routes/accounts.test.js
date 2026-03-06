const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const bcrypt = require("bcryptjs");

const Account = require("../models/Account");
const User = require("../models/User");
const AccountUser = require("../models/AccountUser");
const accountsRouter = require("./accounts");

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
    req.user = { userId: new mongoose.Types.ObjectId(), role: 1 };
    next();
  });
  app.use("/api/accounts", accountsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Account.deleteMany({});
  await User.deleteMany({});
  await AccountUser.deleteMany({});
});

describe("POST /api/accounts/register", () => {
  it("registers a new user and account", async () => {
    const res = await request(app)
      .post("/api/accounts/register")
      .send({
        email: "new@test.com",
        password: "password123",
        first_name: "Test",
        last_name: "User",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const user = await User.findOne({ email: "new@test.com" });
    expect(user).toBeTruthy();
  });

  it("returns 400 for missing credentials", async () => {
    const res = await request(app)
      .post("/api/accounts/register")
      .send({ email: "nopass@test.com" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing/i);
  });

  it("returns 400 for duplicate email", async () => {
    await User.create({
      email: "dupe@test.com",
      password: await bcrypt.hash("pass", 10),
      account_id: accountId,
    });

    const res = await request(app)
      .post("/api/accounts/register")
      .send({ email: "dupe@test.com", password: "pass" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/i);
  });
});

describe("POST /api/accounts/login", () => {
  it("logs in with valid credentials (single account)", async () => {
    const account = await Account.create({ name: "Test Co" });
    const password = await bcrypt.hash("mypassword", 10);
    const user = await User.create({
      email: "login@test.com",
      password,
      first_name: "Login",
      account_id: account._id,
    });
    await AccountUser.create({
      user_id: user._id,
      account_id: account._id,
      role: 1,
      has_outbound: false,
      has_research: true,
      is_default: true,
    });

    const res = await request(app)
      .post("/api/accounts/login")
      .send({ email: "login@test.com", password: "mypassword" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.email).toBe("login@test.com");
  });

  it("returns 401 for wrong password", async () => {
    const password = await bcrypt.hash("correct", 10);
    await User.create({
      email: "wrongpw@test.com",
      password,
      account_id: accountId,
    });

    const res = await request(app)
      .post("/api/accounts/login")
      .send({ email: "wrongpw@test.com", password: "incorrect" });

    expect(res.status).toBe(401);
  });

  it("returns 401 for nonexistent user", async () => {
    const res = await request(app)
      .post("/api/accounts/login")
      .send({ email: "ghost@test.com", password: "whatever" });

    expect(res.status).toBe(401);
  });

  it("returns selection prompt for multi-account users", async () => {
    const account1 = await Account.create({ name: "Account 1" });
    const account2 = await Account.create({ name: "Account 2" });
    const password = await bcrypt.hash("pass", 10);
    const user = await User.create({
      email: "multi@test.com",
      password,
      account_id: account1._id,
    });
    await AccountUser.create({ user_id: user._id, account_id: account1._id, role: 1, is_default: true });
    await AccountUser.create({ user_id: user._id, account_id: account2._id, role: 2, is_default: false });

    const res = await request(app)
      .post("/api/accounts/login")
      .send({ email: "multi@test.com", password: "pass" });

    expect(res.status).toBe(200);
    expect(res.body.needs_account_selection).toBe(true);
    expect(res.body.selection_token).toBeTruthy();
    expect(res.body.accounts).toHaveLength(2);
  });
});

describe("POST /api/accounts/select-account", () => {
  it("returns 400 when missing required fields", async () => {
    const res = await request(app)
      .post("/api/accounts/select-account")
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("POST /api/accounts/:id/password", () => {
  it("changes password with correct current password", async () => {
    const password = await bcrypt.hash("oldpass", 10);
    const user = await User.create({
      email: "changepw@test.com",
      password,
      account_id: accountId,
    });

    const res = await request(app)
      .post(`/api/accounts/${user._id}/password`)
      .send({ current_password: "oldpass", new_password: "newpass" });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/updated/i);

    const updated = await User.findById(user._id);
    const ok = await bcrypt.compare("newpass", updated.password);
    expect(ok).toBe(true);
  });

  it("returns 401 for wrong current password", async () => {
    const password = await bcrypt.hash("correct", 10);
    const user = await User.create({
      email: "wrongold@test.com",
      password,
      account_id: accountId,
    });

    const res = await request(app)
      .post(`/api/accounts/${user._id}/password`)
      .send({ current_password: "wrong", new_password: "new" });

    expect(res.status).toBe(401);
  });
});

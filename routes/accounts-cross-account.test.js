const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Account = require("../models/Account");
const User = require("../models/User");
const AccountUser = require("../models/AccountUser");
const accountsRouter = require("./accounts");

let mongoServer;

// Shared IDs
const adminAccountId = new mongoose.Types.ObjectId();
const clientAccountId = new mongoose.Types.ObjectId();
const adminUserId = new mongoose.Types.ObjectId();
const memberUserId = new mongoose.Types.ObjectId();

/**
 * Build a fresh Express app whose middleware injects the given user/account
 * into req, matching the real auth middleware shape.
 */
function buildApp({ userId, accountId, role }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, accountId, role };
    req.account = { _id: accountId };
    // Simulate req.membership (looked up by auth middleware)
    AccountUser.findOne({ user_id: userId, account_id: accountId })
      .lean()
      .then((membership) => {
        req.membership = membership;
        next();
      })
      .catch(next);
  });
  app.use("/api/accounts", accountsRouter);
  return app;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
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

describe("PATCH /api/accounts/:id — cross-account admin fix", () => {
  let adminApp;
  let ownerApp;

  beforeEach(async () => {
    // Create two accounts
    await Account.create({ _id: adminAccountId, name: "Admin HQ" });
    await Account.create({ _id: clientAccountId, name: "Client Co" });

    // Admin user (role 0) belongs to adminAccountId
    await User.create({
      _id: adminUserId,
      email: "admin@quddify.com",
      password: "hashed",
      first_name: "Admin",
      last_name: "User",
    });
    await AccountUser.create({
      user_id: adminUserId,
      account_id: adminAccountId,
      role: 0,
      has_outbound: true,
      has_research: true,
      is_default: true,
    });

    // Team member belongs to the CLIENT account (not the admin's account)
    await User.create({
      _id: memberUserId,
      email: "member@client.com",
      password: "hashed",
      first_name: "Team",
      last_name: "Member",
    });
    await AccountUser.create({
      user_id: memberUserId,
      account_id: clientAccountId,
      role: 2,
      has_outbound: false,
      has_research: false,
      is_default: true,
    });

    adminApp = buildApp({ userId: adminUserId, accountId: adminAccountId, role: 0 });
    ownerApp = buildApp({ userId: memberUserId, accountId: clientAccountId, role: 1 });
  });

  it("admin (role 0) can toggle has_outbound on a member in a DIFFERENT account via account_id in body", async () => {
    const res = await request(adminApp)
      .patch(`/api/accounts/${memberUserId}`)
      .send({ has_outbound: true, account_id: clientAccountId.toString() });

    expect(res.status).toBe(200);
    expect(res.body.has_outbound).toBe(true);

    // Verify the database was actually updated
    const membership = await AccountUser.findOne({
      user_id: memberUserId,
      account_id: clientAccountId,
    }).lean();
    expect(membership.has_outbound).toBe(true);
  });

  it("admin (role 0) can toggle has_outbound on a member in their OWN account without account_id", async () => {
    // Add member to admin's own account too
    await AccountUser.create({
      user_id: memberUserId,
      account_id: adminAccountId,
      role: 2,
      has_outbound: false,
      has_research: false,
    });

    const res = await request(adminApp)
      .patch(`/api/accounts/${memberUserId}`)
      .send({ has_outbound: true });

    expect(res.status).toBe(200);
    expect(res.body.has_outbound).toBe(true);

    // Verify the admin-account membership was updated
    const membership = await AccountUser.findOne({
      user_id: memberUserId,
      account_id: adminAccountId,
    }).lean();
    expect(membership.has_outbound).toBe(true);

    // Verify the client-account membership was NOT touched
    const clientMembership = await AccountUser.findOne({
      user_id: memberUserId,
      account_id: clientAccountId,
    }).lean();
    expect(clientMembership.has_outbound).toBe(false);
  });

  it("non-admin (role 1) passing account_id in body is IGNORED — update targets their own account", async () => {
    // Also give member a membership in admin's account so we can verify it's untouched
    await AccountUser.create({
      user_id: memberUserId,
      account_id: adminAccountId,
      role: 2,
      has_outbound: false,
      has_research: false,
    });

    // ownerApp is role 1 on clientAccountId — tries to sneak adminAccountId in body
    const res = await request(ownerApp)
      .patch(`/api/accounts/${memberUserId}`)
      .send({ has_outbound: true, account_id: adminAccountId.toString() });

    expect(res.status).toBe(200);

    // The update should have gone to the caller's own account (clientAccountId)
    const clientMembership = await AccountUser.findOne({
      user_id: memberUserId,
      account_id: clientAccountId,
    }).lean();
    expect(clientMembership.has_outbound).toBe(true);

    // The admin-account membership should be untouched
    const adminMembership = await AccountUser.findOne({
      user_id: memberUserId,
      account_id: adminAccountId,
    }).lean();
    expect(adminMembership.has_outbound).toBe(false);
  });

  it("admin (role 0) can change a member's role via PATCH", async () => {
    const res = await request(adminApp)
      .patch(`/api/accounts/${memberUserId}`)
      .send({ role: 1, account_id: clientAccountId.toString() });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe(1);

    const membership = await AccountUser.findOne({
      user_id: memberUserId,
      account_id: clientAccountId,
    }).lean();
    expect(membership.role).toBe(1);
  });

  it("non-admin/non-owner cannot change role (returns 403)", async () => {
    // Demote owner to a plain team member on clientAccount
    await AccountUser.updateOne(
      { user_id: memberUserId, account_id: clientAccountId },
      { role: 2 },
    );

    // Add a second user in the client account as a target
    const targetUserId = new mongoose.Types.ObjectId();
    await User.create({
      _id: targetUserId,
      email: "target@client.com",
      password: "hashed",
      first_name: "T",
      last_name: "U",
    });
    await AccountUser.create({
      user_id: targetUserId,
      account_id: clientAccountId,
      role: 2,
    });

    const teamMemberApp = buildApp({ userId: memberUserId, accountId: clientAccountId, role: 2 });

    const res = await request(teamMemberApp)
      .patch(`/api/accounts/${targetUserId}`)
      .send({ role: 1 });

    expect(res.status).toBe(403);
  });

  it("rejects role change on self (returns 400)", async () => {
    const res = await request(adminApp)
      .patch(`/api/accounts/${adminUserId}`)
      .send({ role: 2 });

    expect(res.status).toBe(400);
  });

  it("rejects invalid role values (returns 400)", async () => {
    const res = await request(adminApp)
      .patch(`/api/accounts/${memberUserId}`)
      .send({ role: 99, account_id: clientAccountId.toString() });

    expect(res.status).toBe(400);
  });

  it("returns 200 but membership fields are null when AccountUser is not found for the given account (regression)", async () => {
    // Admin targets clientAccountId but for a user that has NO membership there
    const orphanUserId = new mongoose.Types.ObjectId();
    await User.create({
      _id: orphanUserId,
      email: "orphan@test.com",
      password: "hashed",
      first_name: "Orphan",
      last_name: "User",
    });

    const res = await request(adminApp)
      .patch(`/api/accounts/${orphanUserId}`)
      .send({ has_outbound: true, account_id: clientAccountId.toString() });

    expect(res.status).toBe(200);

    // The response should reflect that no membership was found —
    // has_outbound falls back to undefined/falsy since updatedMembership is null
    // (the ?. optional chaining returns undefined, ?? falls through)
    expect(res.body.has_outbound).toBeFalsy();

    // Confirm no AccountUser was created
    const membership = await AccountUser.findOne({
      user_id: orphanUserId,
      account_id: clientAccountId,
    });
    expect(membership).toBeNull();
  });
});

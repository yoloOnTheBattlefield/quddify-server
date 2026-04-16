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

describe("GET /api/outbound-accounts/export", () => {
  it("returns CSV with headers and account rows", async () => {
    await OutboundAccount.create({ account_id: accountId, username: "user1", password: "p1", email: "a@b.com", status: "ready" });
    await OutboundAccount.create({ account_id: accountId, username: "user2", proxy: "1.2.3.4:8080" });

    const res = await request(app).get("/api/outbound-accounts/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toBe("attachment; filename=outbound-accounts.csv");

    const lines = res.text.split("\n");
    expect(lines[0]).toBe("username,password,email,emailPassword,proxy,status,assignedTo,isBlacklisted,isConnectedToAISetter,notes,twoFA,hidemyacc_profile_id,createdAt");
    expect(lines.length).toBe(3); // header + 2 rows
    expect(lines[1]).toContain("user2"); // sorted by createdAt desc
    expect(lines[2]).toContain("user1");
  });

  it("returns empty CSV when no accounts", async () => {
    const res = await request(app).get("/api/outbound-accounts/export");
    expect(res.status).toBe(200);

    const lines = res.text.split("\n");
    expect(lines.length).toBe(1); // header only
  });

  it("only exports accounts for the current tenant", async () => {
    await OutboundAccount.create({ account_id: accountId, username: "mine" });
    await OutboundAccount.create({ account_id: new mongoose.Types.ObjectId(), username: "theirs" });

    const res = await request(app).get("/api/outbound-accounts/export");
    const lines = res.text.split("\n");
    expect(lines.length).toBe(2); // header + 1 row
    expect(lines[1]).toContain("mine");
  });

  it("escapes CSV values with commas and quotes", async () => {
    await OutboundAccount.create({ account_id: accountId, username: "user1", notes: 'has, commas and "quotes"' });

    const res = await request(app).get("/api/outbound-accounts/export");
    const lines = res.text.split("\n");
    expect(lines[1]).toContain('"has, commas and ""quotes"""');
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

describe("POST /api/outbound-accounts/bulk", () => {
  it("creates multiple accounts", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts/bulk")
      .send({
        accounts: [
          { username: "@User1", password: "pass1", email: "a@b.com" },
          { username: "user2", proxy: "1.2.3.4:8080:u:p" },
          { username: "User3", notes: "test" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(3);
    expect(res.body.duplicates).toBe(0);
    expect(res.body.errors).toHaveLength(0);

    const all = await OutboundAccount.find({ account_id: accountId }).lean();
    expect(all).toHaveLength(3);
    expect(all.map((a) => a.username).sort()).toEqual(["user1", "user2", "user3"]);
  });

  it("cleans usernames (@ prefix, trim, lowercase)", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts/bulk")
      .send({ accounts: [{ username: "  @MyHandle  " }] });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);

    const doc = await OutboundAccount.findOne({ account_id: accountId });
    expect(doc.username).toBe("myhandle");
  });

  it("skips duplicates that already exist in DB", async () => {
    await OutboundAccount.create({ account_id: accountId, username: "existing" });

    const res = await request(app)
      .post("/api/outbound-accounts/bulk")
      .send({
        accounts: [
          { username: "existing" },
          { username: "brandnew" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
    expect(res.body.duplicates).toBe(1);
  });

  it("deduplicates within the same batch", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts/bulk")
      .send({
        accounts: [
          { username: "samename" },
          { username: "samename" },
          { username: "unique" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
    expect(res.body.duplicates).toBe(1);
  });

  it("returns errors for rows with missing username", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts/bulk")
      .send({
        accounts: [
          { username: "" },
          { password: "no-username" },
          { username: "good" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors[0].reason).toBe("Missing username");
    expect(res.body.errors[1].reason).toBe("Missing username");
  });

  it("defaults status to 'new' for invalid values", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts/bulk")
      .send({ accounts: [{ username: "statustest", status: "bogus" }] });

    expect(res.status).toBe(201);
    const doc = await OutboundAccount.findOne({ account_id: accountId, username: "statustest" });
    expect(doc.status).toBe("new");
  });

  it("accepts valid status values", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts/bulk")
      .send({ accounts: [{ username: "readyone", status: "ready" }] });

    expect(res.status).toBe(201);
    const doc = await OutboundAccount.findOne({ account_id: accountId, username: "readyone" });
    expect(doc.status).toBe("ready");
  });

  it("stores optional fields (password, email, proxy, etc.)", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts/bulk")
      .send({
        accounts: [{
          username: "full",
          password: "p",
          email: "e@e.com",
          emailPassword: "ep",
          proxy: "1:2:3:4",
          assignedTo: "Bob",
          notes: "note",
          twoFA: "ABC123",
          hidemyacc_profile_id: "hma1",
        }],
      });

    expect(res.status).toBe(201);
    const doc = await OutboundAccount.findOne({ account_id: accountId, username: "full" });
    expect(doc.password).toBe("p");
    expect(doc.email).toBe("e@e.com");
    expect(doc.emailPassword).toBe("ep");
    expect(doc.proxy).toBe("1:2:3:4");
    expect(doc.assignedTo).toBe("Bob");
    expect(doc.notes).toBe("note");
    expect(doc.twoFA).toBe("ABC123");
    expect(doc.hidemyacc_profile_id).toBe("hma1");
  });

  it("returns 400 for empty array", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts/bulk")
      .send({ accounts: [] });

    expect(res.status).toBe(400);
  });

  it("returns 400 for non-array body", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts/bulk")
      .send({ accounts: "not-an-array" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when accounts field is missing", async () => {
    const res = await request(app)
      .post("/api/outbound-accounts/bulk")
      .send({});

    expect(res.status).toBe(400);
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

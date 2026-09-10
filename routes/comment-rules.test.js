const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Account = require("../models/Account");
const OutboundAccount = require("../models/OutboundAccount");
const CommentRule = require("../models/CommentRule");
const CommentEvent = require("../models/CommentEvent");
const commentRulesRouter = require("./comment-rules");

let mongoServer;
let app;
const accountId = new mongoose.Types.ObjectId();
const otherAccountId = new mongoose.Types.ObjectId();
const IG_USER_ID = "17841400000000000";
const OUTBOUND_IG_USER_ID = "17841499999999999";

const validRule = {
  ig_user_id: IG_USER_ID,
  name: "Guide",
  keywords: ["guide"],
  dm_text: "Here you go: {{link}}",
  link_url: "https://example.com/guide",
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  await Account.create({
    _id: accountId,
    ghl: "loc_test",
    name: "Test",
    ig_oauth: { ig_user_id: IG_USER_ID, ig_username: "ourbrand" },
  });
  await Account.create({ _id: otherAccountId, ghl: "loc_other", name: "Other" });
  await OutboundAccount.create({
    account_id: accountId,
    username: "sender1",
    ig_oauth: { ig_user_id: OUTBOUND_IG_USER_ID, ig_username: "sender1" },
  });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = { _id: accountId, ghl: "loc_test" };
    next();
  });
  app.use("/api/comment-rules", commentRulesRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await CommentRule.deleteMany({});
  await CommentEvent.deleteMany({});
});

describe("POST /api/comment-rules", () => {
  it("creates a rule for a connected IG account", async () => {
    const res = await request(app).post("/api/comment-rules").send(validRule);

    expect(res.status).toBe(201);
    expect(res.body.rule.keywords).toEqual(["guide"]);
    expect(res.body.rule.match_mode).toBe("partial");
    expect(res.body.rule.active).toBe(true);
    expect(res.body.rule.account_id).toBe(accountId.toString());
  });

  it("creates a rule for a connected outbound IG account", async () => {
    const res = await request(app)
      .post("/api/comment-rules")
      .send({ ...validRule, ig_user_id: OUTBOUND_IG_USER_ID });

    expect(res.status).toBe(201);
  });

  it("rejects an IG account that is not connected", async () => {
    const res = await request(app)
      .post("/api/comment-rules")
      .send({ ...validRule, ig_user_id: "17841499999900000" });

    expect(res.status).toBe(403);
    expect(await CommentRule.countDocuments()).toBe(0);
  });

  it("rejects a rule with no keywords", async () => {
    const res = await request(app)
      .post("/api/comment-rules")
      .send({ ...validRule, keywords: [] });

    expect(res.status).toBe(400);
  });

  it("rejects a missing dm_text", async () => {
    const { dm_text, ...withoutDm } = validRule;
    const res = await request(app).post("/api/comment-rules").send(withoutDm);

    expect(res.status).toBe(400);
  });

  it("rejects a link_url that is not a URL", async () => {
    const res = await request(app)
      .post("/api/comment-rules")
      .send({ ...validRule, link_url: "not-a-url" });

    expect(res.status).toBe(400);
  });

  it("ignores a client-supplied account_id", async () => {
    const res = await request(app)
      .post("/api/comment-rules")
      .send({ ...validRule, account_id: otherAccountId.toString() });

    expect(res.status).toBe(201);
    expect(res.body.rule.account_id).toBe(accountId.toString());
  });
});

describe("GET /api/comment-rules", () => {
  it("returns only this account's rules", async () => {
    await CommentRule.create({ ...validRule, account_id: accountId });
    await CommentRule.create({ ...validRule, account_id: otherAccountId, name: "Theirs" });

    const res = await request(app).get("/api/comment-rules");

    expect(res.status).toBe(200);
    expect(res.body.rules).toHaveLength(1);
    expect(res.body.rules[0].name).toBe("Guide");
  });
});

describe("PATCH /api/comment-rules/:id", () => {
  it("updates a rule", async () => {
    const rule = await CommentRule.create({ ...validRule, account_id: accountId });

    const res = await request(app)
      .patch(`/api/comment-rules/${rule._id}`)
      .send({ active: false, keywords: ["guide", "send"] });

    expect(res.status).toBe(200);
    expect(res.body.rule.active).toBe(false);
    expect(res.body.rule.keywords).toEqual(["guide", "send"]);
  });

  it("does not update another account's rule", async () => {
    const rule = await CommentRule.create({ ...validRule, account_id: otherAccountId });

    const res = await request(app)
      .patch(`/api/comment-rules/${rule._id}`)
      .send({ active: false });

    expect(res.status).toBe(404);
    expect((await CommentRule.findById(rule._id)).active).toBe(true);
  });

  it("rejects an empty update", async () => {
    const rule = await CommentRule.create({ ...validRule, account_id: accountId });
    const res = await request(app).patch(`/api/comment-rules/${rule._id}`).send({});

    expect(res.status).toBe(400);
  });

  it("rejects repointing a rule at an unconnected IG account", async () => {
    const rule = await CommentRule.create({ ...validRule, account_id: accountId });
    const res = await request(app)
      .patch(`/api/comment-rules/${rule._id}`)
      .send({ ig_user_id: "17841499999900000" });

    expect(res.status).toBe(403);
  });

  it("rejects a malformed id", async () => {
    const res = await request(app).patch("/api/comment-rules/nope").send({ active: false });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/comment-rules/:id", () => {
  it("deletes a rule", async () => {
    const rule = await CommentRule.create({ ...validRule, account_id: accountId });

    const res = await request(app).delete(`/api/comment-rules/${rule._id}`);

    expect(res.status).toBe(200);
    expect(await CommentRule.countDocuments()).toBe(0);
  });

  it("does not delete another account's rule", async () => {
    const rule = await CommentRule.create({ ...validRule, account_id: otherAccountId });

    const res = await request(app).delete(`/api/comment-rules/${rule._id}`);

    expect(res.status).toBe(404);
    expect(await CommentRule.countDocuments()).toBe(1);
  });
});

describe("GET /api/comment-rules/events", () => {
  beforeEach(async () => {
    await CommentEvent.create([
      {
        account_id: accountId,
        ig_user_id: IG_USER_ID,
        comment_id: "c1",
        status: "sent",
        commenter_username: "a",
      },
      {
        account_id: accountId,
        ig_user_id: IG_USER_ID,
        comment_id: "c2",
        status: "failed",
        commenter_username: "b",
      },
      {
        account_id: otherAccountId,
        ig_user_id: IG_USER_ID,
        comment_id: "c3",
        status: "sent",
        commenter_username: "c",
      },
    ]);
  });

  it("returns only this account's events", async () => {
    const res = await request(app).get("/api/comment-rules/events");

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events.map((e) => e.comment_id).sort()).toEqual(["c1", "c2"]);
  });

  it("filters by status", async () => {
    const res = await request(app).get("/api/comment-rules/events?status=failed");

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].comment_id).toBe("c2");
  });

  it("rejects an unknown status", async () => {
    const res = await request(app).get("/api/comment-rules/events?status=bogus");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/comment-rules/ig-accounts", () => {
  it("lists the account's and outbound IG accounts", async () => {
    const res = await request(app).get("/api/comment-rules/ig-accounts");

    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual(
      expect.arrayContaining([
        { ig_user_id: IG_USER_ID, ig_username: "ourbrand", kind: "account" },
        { ig_user_id: OUTBOUND_IG_USER_ID, ig_username: "sender1", kind: "outbound" },
      ]),
    );
  });
});

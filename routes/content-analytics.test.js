const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

jest.mock("../services/instagramInsights", () => ({
  syncAccountInsights: jest.fn(),
}));

const MediaInsight = require("../models/MediaInsight");
const CommentEvent = require("../models/CommentEvent");
const instagramInsights = require("../services/instagramInsights");
const contentAnalyticsRouter = require("./content-analytics");

let mongoServer;
let app;
const accountId = new mongoose.Types.ObjectId();
const otherAccountId = new mongoose.Types.ObjectId();
const IG_USER_ID = "17841400000000000";

function post(overrides = {}) {
  return {
    account_id: accountId,
    ig_user_id: IG_USER_ID,
    media_id: "media_1",
    permalink: "https://instagram.com/p/abc",
    media_product_type: "REELS",
    posted_at: new Date(),
    like_count: 120,
    comments_count: 14,
    views: 10000,
    reach: 8000,
    shares: 30,
    saved: 45,
    total_interactions: 209,
    ...overrides,
  };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await MediaInsight.syncIndexes();

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = { _id: accountId, ghl: "loc_test" };
    next();
  });
  app.use("/api/content-analytics", contentAnalyticsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  jest.clearAllMocks();
  await MediaInsight.deleteMany({});
  await CommentEvent.deleteMany({});
});

describe("GET /api/content-analytics", () => {
  it("returns cached post metrics for this account only", async () => {
    await MediaInsight.create(post());
    await MediaInsight.create(post({ account_id: otherAccountId, media_id: "media_other" }));

    const res = await request(app).get("/api/content-analytics");

    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(1);
    expect(res.body.posts[0]).toMatchObject({
      media_id: "media_1",
      views: 10000,
      likes: 120,
      shares: 30,
      saved: 45,
    });
  });

  it("attributes leads to the post whose comments triggered them", async () => {
    await MediaInsight.create(post());
    const leadA = new mongoose.Types.ObjectId();
    const leadB = new mongoose.Types.ObjectId();

    await CommentEvent.create([
      { account_id: accountId, ig_user_id: IG_USER_ID, comment_id: "c1", media_id: "media_1", status: "sent", lead_id: leadA },
      { account_id: accountId, ig_user_id: IG_USER_ID, comment_id: "c2", media_id: "media_1", status: "sent", lead_id: leadB },
      // Same lead commenting twice must not count twice
      { account_id: accountId, ig_user_id: IG_USER_ID, comment_id: "c3", media_id: "media_1", status: "sent", lead_id: leadA },
      // Queued, and no lead yet
      { account_id: accountId, ig_user_id: IG_USER_ID, comment_id: "c4", media_id: "media_1", status: "queued" },
    ]);

    const res = await request(app).get("/api/content-analytics");
    const row = res.body.posts[0];

    expect(row.comments_matched).toBe(4);
    expect(row.dms_sent).toBe(3);
    expect(row.leads_generated).toBe(2);
    expect(row.leads_per_1k_views).toBe(0.2);
  });

  it("does not attribute another account's comment events", async () => {
    await MediaInsight.create(post());
    await CommentEvent.create({
      account_id: otherAccountId,
      ig_user_id: IG_USER_ID,
      comment_id: "c9",
      media_id: "media_1",
      status: "sent",
      lead_id: new mongoose.Types.ObjectId(),
    });

    const res = await request(app).get("/api/content-analytics");

    expect(res.body.posts[0].leads_generated).toBe(0);
  });

  it("reports zeros for a post with no comment activity", async () => {
    await MediaInsight.create(post());

    const res = await request(app).get("/api/content-analytics");

    expect(res.body.posts[0]).toMatchObject({
      comments_matched: 0,
      dms_sent: 0,
      leads_generated: 0,
      leads_per_1k_views: 0,
    });
  });

  it("leaves leads_per_1k_views null when views are unavailable", async () => {
    await MediaInsight.create(post({ views: null }));

    const res = await request(app).get("/api/content-analytics");

    expect(res.body.posts[0].views).toBeNull();
    expect(res.body.posts[0].leads_per_1k_views).toBeNull();
  });

  it("excludes posts older than the requested window", async () => {
    await MediaInsight.create(post({ media_id: "old", posted_at: new Date(Date.now() - 200 * 86400000) }));
    await MediaInsight.create(post());

    const res = await request(app).get("/api/content-analytics?days=30");

    expect(res.body.posts.map((p) => p.media_id)).toEqual(["media_1"]);
    expect(res.body.days).toBe(30);
  });

  it("totals the visible posts", async () => {
    await MediaInsight.create(post());
    await MediaInsight.create(post({ media_id: "media_2", views: 5000, like_count: 10 }));

    const res = await request(app).get("/api/content-analytics");

    expect(res.body.totals).toMatchObject({ posts: 2, views: 15000, likes: 130 });
  });
});

describe("POST /api/content-analytics/sync", () => {
  it("triggers a refresh and returns the counts", async () => {
    instagramInsights.syncAccountInsights.mockResolvedValue({ synced: 12, with_insights: 11 });

    const res = await request(app).post("/api/content-analytics/sync").send({ days: 30 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ synced: 12, with_insights: 11 });
    expect(instagramInsights.syncAccountInsights).toHaveBeenCalledWith(accountId, { days: 30 });
  });

  it("explains that metrics need a Meta connection, not Zernio", async () => {
    const err = new Error("Instagram content analytics need a Meta connection.");
    err.code = "NO_META_CONNECTION";
    instagramInsights.syncAccountInsights.mockRejectedValue(err);

    const res = await request(app).post("/api/content-analytics/sync").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Meta connection/i);
  });

  it("surfaces a Graph API failure as 502", async () => {
    instagramInsights.syncAccountInsights.mockRejectedValue(new Error("rate limited"));

    const res = await request(app).post("/api/content-analytics/sync").send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("rate limited");
  });
});

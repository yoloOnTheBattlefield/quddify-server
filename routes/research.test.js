const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const ResearchPost = require("../models/ResearchPost");
const ResearchComment = require("../models/ResearchComment");

jest.mock("../utils/logger", () => {
  const noop = () => {};
  const logger = { info: noop, error: noop, warn: noop, debug: noop, child: () => logger };
  return logger;
});

const researchRouter = require("./research");

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
  app.use("/api/research", researchRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ResearchPost.deleteMany({});
  await ResearchComment.deleteMany({});
});

function createPost(overrides = {}) {
  return ResearchPost.create({
    account_id: accountId,
    competitor_handle: "competitor1",
    post_type: "reel",
    reel_id: `reel_${Date.now()}_${Math.random()}`,
    caption: "Test caption",
    comments_count: 10,
    likes_count: 100,
    posted_at: new Date(),
    scraped_at: new Date(),
    ...overrides,
  });
}

function createComment(overrides = {}) {
  return ResearchComment.create({
    account_id: accountId,
    commenter_username: "commenter1",
    comment_text: "Great post!",
    scraped_at: new Date(),
    ...overrides,
  });
}

describe("GET /api/research/overview-kpis", () => {
  it("returns zeroes when no data exists", async () => {
    const res = await request(app).get("/api/research/overview-kpis");
    expect(res.status).toBe(200);
    expect(res.body.postsTracked).toBe(0);
    expect(res.body.commentsAnalyzed).toBe(0);
    expect(res.body.uniqueCommenters).toBe(0);
    expect(res.body.newPostsSinceLogin).toBe(0);
  });

  it("returns correct KPI counts", async () => {
    await createPost({ scraped_at: new Date() });
    await createPost({ scraped_at: new Date() });
    await createComment({ commenter_username: "user1" });
    await createComment({ commenter_username: "user2" });
    await createComment({ commenter_username: "user1" }); // duplicate commenter

    const res = await request(app).get("/api/research/overview-kpis");
    expect(res.status).toBe(200);
    expect(res.body.postsTracked).toBe(2);
    expect(res.body.commentsAnalyzed).toBe(3);
    expect(res.body.uniqueCommenters).toBe(2);
    expect(res.body.newPostsSinceLogin).toBe(2);
  });

  it("does not count data from other accounts", async () => {
    const otherId = new mongoose.Types.ObjectId();
    await createPost({ account_id: otherId, reel_id: "other_reel" });
    await createComment({ account_id: otherId });

    const res = await request(app).get("/api/research/overview-kpis");
    expect(res.body.postsTracked).toBe(0);
    expect(res.body.commentsAnalyzed).toBe(0);
  });
});

describe("GET /api/research/engagement-trend", () => {
  it("returns 30 days of data", async () => {
    const res = await request(app).get("/api/research/engagement-trend");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(30);
    expect(res.body[0].date).toBeDefined();
  });

  it("includes comment counts grouped by handle and date", async () => {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    await createPost({
      competitor_handle: "handle_a",
      comments_count: 5,
      posted_at: now,
    });
    await createPost({
      competitor_handle: "handle_b",
      comments_count: 3,
      posted_at: now,
    });

    const res = await request(app).get("/api/research/engagement-trend");
    expect(res.status).toBe(200);
    const todayEntry = res.body.find((d) => d.date === dateStr);
    expect(todayEntry).toBeDefined();
    expect(todayEntry.handle_a).toBe(5);
    expect(todayEntry.handle_b).toBe(3);
  });
});

describe("GET /api/research/top-posts", () => {
  it("returns empty array when no posts", async () => {
    const res = await request(app).get("/api/research/top-posts");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("returns posts sorted by comments_count descending", async () => {
    await createPost({ comments_count: 5, reel_id: "reel_a" });
    await createPost({ comments_count: 20, reel_id: "reel_b" });
    await createPost({ comments_count: 10, reel_id: "reel_c" });

    const res = await request(app).get("/api/research/top-posts");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0].commentsCount).toBe(20);
    expect(res.body[1].commentsCount).toBe(10);
    expect(res.body[2].commentsCount).toBe(5);
  });

  it("respects the limit query param", async () => {
    for (let i = 0; i < 5; i++) {
      await createPost({ reel_id: `limited_${i}`, comments_count: i });
    }

    const res = await request(app).get("/api/research/top-posts?limit=2");
    expect(res.body).toHaveLength(2);
  });

  it("caps limit at 50", async () => {
    const res = await request(app).get("/api/research/top-posts?limit=100");
    expect(res.status).toBe(200);
    // Just verifies the route doesn't crash with a high limit
  });
});

describe("GET /api/research/competitors", () => {
  it("returns empty array when no posts", async () => {
    const res = await request(app).get("/api/research/competitors");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("aggregates competitors from posts", async () => {
    await createPost({ competitor_handle: "comp_a", comments_count: 10, reel_id: "ca_1" });
    await createPost({ competitor_handle: "comp_a", comments_count: 20, reel_id: "ca_2" });
    await createPost({ competitor_handle: "comp_b", comments_count: 5, reel_id: "cb_1" });

    const res = await request(app).get("/api/research/competitors");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const compA = res.body.find((c) => c.handle === "comp_a");
    expect(compA.postsTracked).toBe(2);
    expect(compA.avgComments).toBe(15); // (10+20)/2

    const compB = res.body.find((c) => c.handle === "comp_b");
    expect(compB.postsTracked).toBe(1);
    expect(compB.avgComments).toBe(5);
  });
});

describe("GET /api/research/competitors/:handle", () => {
  it("returns 404 for unknown competitor", async () => {
    const res = await request(app).get("/api/research/competitors/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns competitor stats", async () => {
    await createPost({ competitor_handle: "test_comp", comments_count: 8, reel_id: "tc_1" });
    await createPost({ competitor_handle: "test_comp", comments_count: 12, reel_id: "tc_2" });

    const res = await request(app).get("/api/research/competitors/test_comp");
    expect(res.status).toBe(200);
    expect(res.body.handle).toBe("test_comp");
    expect(res.body.postsTracked).toBe(2);
    expect(res.body.avgComments).toBe(10);
  });
});

describe("GET /api/research/posts", () => {
  it("returns paginated posts", async () => {
    for (let i = 0; i < 5; i++) {
      await createPost({ reel_id: `paginated_${i}` });
    }

    const res = await request(app).get("/api/research/posts?page=1&limit=2");
    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.totalPages).toBe(3);
    expect(res.body.page).toBe(1);
  });

  it("filters by competitor handle", async () => {
    await createPost({ competitor_handle: "target", reel_id: "filter_1" });
    await createPost({ competitor_handle: "other", reel_id: "filter_2" });

    const res = await request(app).get("/api/research/posts?competitor=target");
    expect(res.body.posts).toHaveLength(1);
    expect(res.body.posts[0].competitorHandle).toBe("target");
  });

  it("filters by post_type", async () => {
    await createPost({ post_type: "reel", reel_id: "type_1" });
    await createPost({ post_type: "image", reel_id: "type_2" });

    const res = await request(app).get("/api/research/posts?post_type=image");
    expect(res.body.posts).toHaveLength(1);
    expect(res.body.posts[0].postType).toBe("image");
  });

  it("searches by caption", async () => {
    await createPost({ caption: "Amazing growth hack", reel_id: "search_1" });
    await createPost({ caption: "Boring content", reel_id: "search_2" });

    const res = await request(app).get("/api/research/posts?search=growth");
    expect(res.body.posts).toHaveLength(1);
    expect(res.body.posts[0].caption).toContain("growth");
  });

  it("sorts by most_comments", async () => {
    await createPost({ comments_count: 5, reel_id: "sort_1" });
    await createPost({ comments_count: 50, reel_id: "sort_2" });

    const res = await request(app).get("/api/research/posts?sort_by=most_comments");
    expect(res.body.posts[0].commentsCount).toBe(50);
  });
});

describe("GET /api/research/commenters", () => {
  it("returns empty array when no comments", async () => {
    const res = await request(app).get("/api/research/commenters");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("aggregates commenters with counts", async () => {
    await createComment({ commenter_username: "alice" });
    await createComment({ commenter_username: "alice" });
    await createComment({ commenter_username: "bob" });

    const res = await request(app).get("/api/research/commenters");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const alice = res.body.find((c) => c.username === "alice");
    expect(alice.commentCount).toBe(2);

    const bob = res.body.find((c) => c.username === "bob");
    expect(bob.commentCount).toBe(1);
  });

  it("sorts by comment count descending", async () => {
    await createComment({ commenter_username: "low" });
    await createComment({ commenter_username: "high" });
    await createComment({ commenter_username: "high" });
    await createComment({ commenter_username: "high" });

    const res = await request(app).get("/api/research/commenters");
    expect(res.body[0].username).toBe("high");
    expect(res.body[0].commentCount).toBe(3);
  });
});

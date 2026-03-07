const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const DeepScrapeJob = require("../models/DeepScrapeJob");
const ApifyToken = require("../models/ApifyToken");
const OutboundLead = require("../models/OutboundLead");

// Mock deepScraper to avoid real Apify calls
jest.mock("../services/deepScraper", () => ({
  processJob: jest.fn(),
  pauseJob: jest.fn(() => true),
  cancelJob: jest.fn(() => true),
  skipComments: jest.fn(() => true),
}));

const deepScrapeRouter = require("./deep-scrape");

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
  app.use("/api/deep-scrape", deepScrapeRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await DeepScrapeJob.deleteMany({});
  await ApifyToken.deleteMany({});
  await OutboundLead.deleteMany({});
});

async function seedApifyToken() {
  return ApifyToken.create({
    account_id: accountId,
    token: "apify_test_token",
    status: "active",
  });
}

describe("POST /api/deep-scrape/start", () => {
  it("creates a job with seed usernames", async () => {
    await seedApifyToken();

    const res = await request(app)
      .post("/api/deep-scrape/start")
      .send({ seed_usernames: ["@testuser"] });

    expect(res.status).toBe(201);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.status).toBe("pending");

    const job = await DeepScrapeJob.findById(res.body.jobId);
    expect(job.seed_usernames).toEqual(["testuser"]);
  });

  it("creates a job with direct URLs", async () => {
    await seedApifyToken();

    const res = await request(app)
      .post("/api/deep-scrape/start")
      .send({ direct_urls: ["https://instagram.com/reel/ABC123"] });

    expect(res.status).toBe(201);
    const job = await DeepScrapeJob.findById(res.body.jobId);
    expect(job.direct_urls).toHaveLength(1);
  });

  it("creates a job with scrape_likers enabled", async () => {
    await seedApifyToken();

    const res = await request(app)
      .post("/api/deep-scrape/start")
      .send({
        seed_usernames: ["@testuser"],
        scrape_comments: true,
        scrape_likers: true,
      });

    expect(res.status).toBe(201);
    const job = await DeepScrapeJob.findById(res.body.jobId);
    expect(job.scrape_comments).toBe(true);
    expect(job.scrape_likers).toBe(true);
  });

  it("creates a job with only likers (no comments)", async () => {
    await seedApifyToken();

    const res = await request(app)
      .post("/api/deep-scrape/start")
      .send({
        seed_usernames: ["@testuser"],
        scrape_comments: false,
        scrape_likers: true,
      });

    expect(res.status).toBe(201);
    const job = await DeepScrapeJob.findById(res.body.jobId);
    expect(job.scrape_comments).toBe(false);
    expect(job.scrape_likers).toBe(true);
  });

  it("creates a job with scrape_followers enabled", async () => {
    await seedApifyToken();

    const res = await request(app)
      .post("/api/deep-scrape/start")
      .send({
        seed_usernames: ["@testuser"],
        scrape_followers: true,
      });

    expect(res.status).toBe(201);
    const job = await DeepScrapeJob.findById(res.body.jobId);
    expect(job.scrape_followers).toBe(true);
  });

  it("creates a job with only followers (no comments, no likers)", async () => {
    await seedApifyToken();

    const res = await request(app)
      .post("/api/deep-scrape/start")
      .send({
        seed_usernames: ["@testuser"],
        scrape_comments: false,
        scrape_likers: false,
        scrape_followers: true,
      });

    expect(res.status).toBe(201);
    const job = await DeepScrapeJob.findById(res.body.jobId);
    expect(job.scrape_comments).toBe(false);
    expect(job.scrape_likers).toBe(false);
    expect(job.scrape_followers).toBe(true);
  });

  it("defaults scrape_followers to false", async () => {
    await seedApifyToken();

    const res = await request(app)
      .post("/api/deep-scrape/start")
      .send({ seed_usernames: ["@testuser"] });

    expect(res.status).toBe(201);
    const job = await DeepScrapeJob.findById(res.body.jobId);
    expect(job.scrape_followers).toBe(false);
  });

  it("defaults scrape_comments to true and scrape_likers to false", async () => {
    await seedApifyToken();

    const res = await request(app)
      .post("/api/deep-scrape/start")
      .send({ seed_usernames: ["@testuser"] });

    expect(res.status).toBe(201);
    const job = await DeepScrapeJob.findById(res.body.jobId);
    expect(job.scrape_comments).toBe(true);
    expect(job.scrape_likers).toBe(false);
  });

  it("returns 400 without seeds or URLs", async () => {
    await seedApifyToken();

    const res = await request(app)
      .post("/api/deep-scrape/start")
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 400 without Apify token", async () => {
    const res = await request(app)
      .post("/api/deep-scrape/start")
      .send({ seed_usernames: ["user1"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/apify/i);
  });

  it("filters out invalid direct URLs", async () => {
    await seedApifyToken();

    const res = await request(app)
      .post("/api/deep-scrape/start")
      .send({
        direct_urls: [
          "https://instagram.com/reel/VALID123",
          "https://example.com/page/123",
          "random text",
        ],
      });

    expect(res.status).toBe(201);
    const job = await DeepScrapeJob.findById(res.body.jobId);
    expect(job.direct_urls).toHaveLength(1);
  });
});

describe("GET /api/deep-scrape", () => {
  it("returns empty list", async () => {
    const res = await request(app).get("/api/deep-scrape");
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(0);
  });

  it("returns jobs for current account only", async () => {
    await DeepScrapeJob.create({ account_id: accountId, seed_usernames: ["a"] });
    await DeepScrapeJob.create({ account_id: new mongoose.Types.ObjectId(), seed_usernames: ["b"] });

    const res = await request(app).get("/api/deep-scrape");
    expect(res.body.jobs).toHaveLength(1);
  });

  it("filters by status", async () => {
    await DeepScrapeJob.create({ account_id: accountId, seed_usernames: ["a"], status: "completed" });
    await DeepScrapeJob.create({ account_id: accountId, seed_usernames: ["b"], status: "pending" });

    const res = await request(app).get("/api/deep-scrape?status=completed");
    expect(res.body.jobs).toHaveLength(1);
  });

  it("paginates results", async () => {
    for (let i = 0; i < 5; i++) {
      await DeepScrapeJob.create({ account_id: accountId, seed_usernames: [`user${i}`] });
    }

    const res = await request(app).get("/api/deep-scrape?page=1&limit=2");
    expect(res.body.jobs).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
  });
});

describe("GET /api/deep-scrape/:id", () => {
  it("returns a single job", async () => {
    const job = await DeepScrapeJob.create({ account_id: accountId, seed_usernames: ["single"] });

    const res = await request(app).get(`/api/deep-scrape/${job._id}`);
    expect(res.status).toBe(200);
    expect(res.body.seed_usernames).toEqual(["single"]);
  });

  it("returns 404 for wrong account", async () => {
    const job = await DeepScrapeJob.create({
      account_id: new mongoose.Types.ObjectId(),
      seed_usernames: ["other"],
    });

    const res = await request(app).get(`/api/deep-scrape/${job._id}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid id", async () => {
    const res = await request(app).get("/api/deep-scrape/invalid");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/deep-scrape/:id/leads", () => {
  it("returns leads for a job", async () => {
    const job = await DeepScrapeJob.create({ account_id: accountId, seed_usernames: ["s"] });
    await OutboundLead.create({
      account_id: accountId,
      followingKey: "lead1",
      username: "lead1",
      metadata: { executionId: `deep-scrape-${job._id}` },
    });

    const res = await request(app).get(`/api/deep-scrape/${job._id}/leads`);
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].username).toBe("lead1");
  });
});

describe("POST /api/deep-scrape/:id/pause", () => {
  it("pauses an active job", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "scraping_reels",
    });

    const res = await request(app).post(`/api/deep-scrape/${job._id}/pause`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("pauses a job in scraping_likers status", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "scraping_likers",
    });

    const res = await request(app).post(`/api/deep-scrape/${job._id}/pause`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("pauses a job in scraping_followers status", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "scraping_followers",
    });

    const res = await request(app).post(`/api/deep-scrape/${job._id}/pause`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("rejects pause on completed job", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "completed",
    });

    const res = await request(app).post(`/api/deep-scrape/${job._id}/pause`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/deep-scrape/:id/cancel", () => {
  it("cancels an active job", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "scraping_comments",
    });

    const res = await request(app).post(`/api/deep-scrape/${job._id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("rejects cancel on completed job", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "completed",
    });

    const res = await request(app).post(`/api/deep-scrape/${job._id}/cancel`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/deep-scrape/:id/resume", () => {
  it("resumes a failed job", async () => {
    await seedApifyToken();
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "failed",
      error: "some error",
    });

    const res = await request(app).post(`/api/deep-scrape/${job._id}/resume`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resumed");

    const updated = await DeepScrapeJob.findById(job._id);
    expect(updated.status).toBe("pending");
    expect(updated.error).toBeNull();
  });

  it("rejects resume on active job", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "scraping_reels",
    });

    const res = await request(app).post(`/api/deep-scrape/${job._id}/resume`);
    expect(res.status).toBe(400);
  });

  it("rejects resume without Apify token", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "failed",
    });

    const res = await request(app).post(`/api/deep-scrape/${job._id}/resume`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/apify/i);
  });
});

describe("PATCH /api/deep-scrape/:id", () => {
  it("updates job config", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["old"],
      status: "pending",
    });

    const res = await request(app)
      .patch(`/api/deep-scrape/${job._id}`)
      .send({ seed_usernames: ["@new_user"], name: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body.seed_usernames).toEqual(["new_user"]);
    expect(res.body.name).toBe("Updated");
  });

  it("rejects edit on running job", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "scraping_reels",
    });

    const res = await request(app)
      .patch(`/api/deep-scrape/${job._id}`)
      .send({ name: "Nope" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pause|cancel/i);
  });
});

describe("DELETE /api/deep-scrape/:id", () => {
  it("deletes a completed job", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "completed",
    });

    const res = await request(app).delete(`/api/deep-scrape/${job._id}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const found = await DeepScrapeJob.findById(job._id);
    expect(found).toBeNull();
  });

  it("rejects deletion of active job", async () => {
    const job = await DeepScrapeJob.create({
      account_id: accountId,
      seed_usernames: ["s"],
      status: "scraping_reels",
    });

    const res = await request(app).delete(`/api/deep-scrape/${job._id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cancel/i);
  });

  it("returns 404 for wrong account", async () => {
    const job = await DeepScrapeJob.create({
      account_id: new mongoose.Types.ObjectId(),
      seed_usernames: ["s"],
      status: "completed",
    });

    const res = await request(app).delete(`/api/deep-scrape/${job._id}`);
    expect(res.status).toBe(404);
  });
});

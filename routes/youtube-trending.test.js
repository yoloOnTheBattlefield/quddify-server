const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const TrendingVideo = require("../models/TrendingVideo");

jest.mock("../utils/logger", () => {
  const noop = () => {};
  const logger = { info: noop, error: noop, warn: noop, debug: noop, child: () => logger };
  return logger;
});

const trendingRouter = require("./youtube-trending");

let mongoServer;
let app;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use("/trending", trendingRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await TrendingVideo.deleteMany({});
});

describe("GET /trending", () => {
  it("returns empty when no trending data exists", async () => {
    const res = await request(app).get("/trending");
    expect(res.status).toBe(200);
    expect(res.body.batch_id).toBeNull();
    expect(res.body.videos).toEqual([]);
  });

  it("returns latest batch of trending videos", async () => {
    const oldBatch = "2025-01-01T00:00:00.000Z";
    const newBatch = "2025-01-02T00:00:00.000Z";

    await TrendingVideo.create([
      {
        video_id: "old1",
        title: "Old",
        views: 100,
        batch_id: oldBatch,
        scraped_at: new Date("2025-01-01"),
      },
      {
        video_id: "new1",
        title: "New High",
        views: 5000,
        batch_id: newBatch,
        scraped_at: new Date("2025-01-02"),
      },
      {
        video_id: "new2",
        title: "New Low",
        views: 1000,
        batch_id: newBatch,
        scraped_at: new Date("2025-01-02"),
      },
    ]);

    const res = await request(app).get("/trending");
    expect(res.status).toBe(200);
    expect(res.body.batch_id).toBe(newBatch);
    expect(res.body.videos).toHaveLength(2);
    // Sorted by views desc
    expect(res.body.videos[0].views).toBe(5000);
    expect(res.body.videos[1].views).toBe(1000);
  });

  it("filters by category", async () => {
    const batch = "2025-01-01T00:00:00.000Z";
    await TrendingVideo.create([
      { video_id: "v1", category: "Music", country: "US", views: 100, batch_id: batch },
      { video_id: "v2", category: "Gaming", country: "US", views: 200, batch_id: batch },
    ]);

    const res = await request(app).get("/trending?category=Music");
    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(1);
    expect(res.body.videos[0].category).toBe("Music");
  });

  it("filters by country", async () => {
    const batch = "2025-01-01T00:00:00.000Z";
    await TrendingVideo.create([
      { video_id: "v1", country: "US", views: 100, batch_id: batch },
      { video_id: "v2", country: "GB", views: 200, batch_id: batch },
    ]);

    const res = await request(app).get("/trending?country=GB");
    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(1);
    expect(res.body.videos[0].country).toBe("GB");
  });
});

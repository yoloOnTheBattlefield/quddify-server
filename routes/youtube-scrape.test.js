const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

jest.mock("../utils/logger", () => {
  const noop = () => {};
  const logger = { info: noop, error: noop, warn: noop, debug: noop, child: () => logger };
  return logger;
});

// Mock the scrape service so tests don't call Apify
jest.mock("../services/scrapeService", () => ({
  runFullPipeline: jest.fn(),
}));

const scrapeService = require("../services/scrapeService");
const scrapeRouter = require("./youtube-scrape");

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
  app.use("/scrape", scrapeRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("POST /scrape/run", () => {
  it("triggers the pipeline and returns results", async () => {
    const mockResult = {
      channels: { scraped: 2, videos: 10 },
      breakouts: { evaluated: 10, alerts: 3 },
      trending: { batch_id: "2025-01-01", videos: 50 },
    };
    scrapeService.runFullPipeline.mockResolvedValueOnce(mockResult);

    const res = await request(app).post("/scrape/run");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.result).toEqual(mockResult);
    expect(scrapeService.runFullPipeline).toHaveBeenCalledWith(accountId);
  });

  it("returns 500 when pipeline fails", async () => {
    scrapeService.runFullPipeline.mockRejectedValueOnce(new Error("No active Apify tokens available"));

    const res = await request(app).post("/scrape/run");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Apify tokens/i);
  });
});

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Channel = require("../models/Channel");

jest.mock("../utils/logger", () => {
  const noop = () => {};
  const logger = { info: noop, error: noop, warn: noop, debug: noop, child: () => logger };
  return logger;
});

const channelRouter = require("./youtube-channels");

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
  app.use("/channels", channelRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Channel.deleteMany({});
});

describe("POST /channels", () => {
  it("creates a new channel with channel_id", async () => {
    const res = await request(app)
      .post("/channels")
      .send({ channel_id: "UC123", channel_name: "Test Channel" });

    expect(res.status).toBe(201);
    expect(res.body.channel_id).toBe("UC123");
    expect(res.body.channel_name).toBe("Test Channel");
    expect(res.body.active).toBe(true);
    expect(res.body.account_id).toBe(accountId.toString());
  });

  it("creates a new channel from channel_url", async () => {
    const res = await request(app)
      .post("/channels")
      .send({ channel_url: "https://www.youtube.com/channel/UCxyz" });

    expect(res.status).toBe(201);
    expect(res.body.channel_id).toBe("UCxyz");
  });

  it("returns 400 when neither channel_id nor channel_url provided", async () => {
    const res = await request(app)
      .post("/channels")
      .send({ channel_name: "Missing ID" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/channel_id or channel_url/);
  });

  it("returns 409 for duplicate channel", async () => {
    await Channel.create({ account_id: accountId, channel_id: "UC123", channel_url: "https://youtube.com/channel/UC123" });

    const res = await request(app)
      .post("/channels")
      .send({ channel_id: "UC123" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already monitored/);
  });
});

describe("GET /channels", () => {
  it("returns channels for current account only", async () => {
    const otherId = new mongoose.Types.ObjectId();
    await Channel.create([
      { account_id: accountId, channel_id: "UC1", channel_url: "https://youtube.com/channel/UC1" },
      { account_id: accountId, channel_id: "UC2", channel_url: "https://youtube.com/channel/UC2" },
      { account_id: otherId, channel_id: "UC3", channel_url: "https://youtube.com/channel/UC3" },
    ]);

    const res = await request(app).get("/channels");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("filters by active status", async () => {
    await Channel.create([
      { account_id: accountId, channel_id: "UC1", channel_url: "https://youtube.com/channel/UC1", active: true },
      { account_id: accountId, channel_id: "UC2", channel_url: "https://youtube.com/channel/UC2", active: false },
    ]);

    const res = await request(app).get("/channels?active=true");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].channel_id).toBe("UC1");
  });
});

describe("DELETE /channels/:id", () => {
  it("deletes an existing channel", async () => {
    await Channel.create({ account_id: accountId, channel_id: "UC123", channel_url: "https://youtube.com/channel/UC123" });

    const res = await request(app).delete("/channels/UC123");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const count = await Channel.countDocuments({});
    expect(count).toBe(0);
  });

  it("returns 404 for non-existent channel", async () => {
    const res = await request(app).delete("/channels/UC_NONEXISTENT");
    expect(res.status).toBe(404);
  });

  it("does not delete another account's channel", async () => {
    const otherId = new mongoose.Types.ObjectId();
    await Channel.create({ account_id: otherId, channel_id: "UC999", channel_url: "https://youtube.com/channel/UC999" });

    const res = await request(app).delete("/channels/UC999");
    expect(res.status).toBe(404);

    const count = await Channel.countDocuments({});
    expect(count).toBe(1);
  });
});

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Account = require("../models/Account");
const telegramRouter = require("./telegram");

let mongoServer;
let app;
let account;

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  account = await Account.create({ ghl: "tg_test" });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = account;
    req.user = { role: 1, userId: new mongoose.Types.ObjectId() };
    next();
  });
  app.use("/api/telegram", telegramRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(() => {
  mockFetch.mockReset();
});

describe("POST /api/telegram/connect", () => {
  it("returns 400 when bot_token is missing", async () => {
    const res = await request(app)
      .post("/api/telegram/connect")
      .send({ chat_id: "123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bot_token.*required/i);
  });

  it("returns 400 when chat_id is missing", async () => {
    const res = await request(app)
      .post("/api/telegram/connect")
      .send({ bot_token: "123:ABC" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chat_id.*required/i);
  });

  it("returns 400 when Telegram API rejects the test message", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ description: "Bad Request: chat not found" }),
    });

    const res = await request(app)
      .post("/api/telegram/connect")
      .send({ bot_token: "bad:token", chat_id: "-999" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/failed to send test message/i);
  });

  it("saves config and returns success when Telegram test message succeeds", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const res = await request(app)
      .post("/api/telegram/connect")
      .send({ bot_token: "123:ABCDEF", chat_id: "-100123" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify stored in DB
    const updated = await Account.findById(account._id).lean();
    expect(updated.telegram_chat_id).toBe("-100123");
    expect(updated.telegram_bot_token).toBeTruthy(); // encrypted
  });
});

describe("DELETE /api/telegram/disconnect", () => {
  it("clears telegram config", async () => {
    // Ensure there's something to clear
    await Account.findByIdAndUpdate(account._id, {
      telegram_bot_token: "encrypted_token",
      telegram_chat_id: "-100123",
    });

    const res = await request(app).delete("/api/telegram/disconnect");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const updated = await Account.findById(account._id).lean();
    expect(updated.telegram_bot_token).toBeNull();
    expect(updated.telegram_chat_id).toBeNull();
  });
});

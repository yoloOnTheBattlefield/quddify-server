const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

jest.mock("../services/zernioClient", () => {
  const actual = jest.requireActual("../services/zernioClient");
  return {
    ...actual,
    listProfiles: jest.fn(),
    listInstagramAccounts: jest.fn(),
    ensureWebhook: jest.fn(),
  };
});

const Account = require("../models/Account");
const { decrypt } = require("../utils/crypto");
const zernioClient = require("../services/zernioClient");
const zernioRouter = require("./zernio");

const API_KEY = "fake-api-key-for-tests-1234567890";

let mongoServer;
let app;
let accountId;

const CONNECT_BODY = {
  api_key: API_KEY,
  profile_id: "p1",
  zernio_account_id: "zacct_1",
  ig_user_id: "17841400000000000",
  ig_username: "ourbrand",
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await Account.deleteMany({});
  const account = await Account.create({ ghl: "loc_test", name: "Test" });
  accountId = account._id;

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = { _id: accountId, ghl: "loc_test" };
    next();
  });
  app.use("/api/zernio", zernioRouter);

  zernioClient.ensureWebhook.mockResolvedValue("wh_1");
  zernioClient.listProfiles.mockResolvedValue([{ id: "p1", name: "Main" }]);
  zernioClient.listInstagramAccounts.mockResolvedValue([
    { id: "zacct_1", ig_user_id: "17841400000000000", username: "ourbrand", name: null },
  ]);
});

describe("GET /api/zernio/status", () => {
  it("reports a disconnected account without leaking anything", async () => {
    const res = await request(app).get("/api/zernio/status");

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.has_api_key).toBe(false);
    expect(res.body.webhook_url).toContain(`/zernio-webhook/${accountId}`);
  });

  it("never returns the stored API key", async () => {
    await request(app).post("/api/zernio/connect").send(CONNECT_BODY);

    const res = await request(app).get("/api/zernio/status");

    expect(res.body.connected).toBe(true);
    expect(res.body.has_api_key).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
  });
});

describe("POST /api/zernio/connect", () => {
  it("stores the connection with the key encrypted and registers the webhook", async () => {
    const res = await request(app).post("/api/zernio/connect").send(CONNECT_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, webhook_registered: true });

    const saved = await Account.findById(accountId).lean();
    expect(saved.zernio.enabled).toBe(true);
    expect(saved.zernio.zernio_account_id).toBe("zacct_1");
    expect(saved.zernio.ig_user_id).toBe("17841400000000000");
    expect(saved.zernio.webhook_id).toBe("wh_1");
    // Stored encrypted, recoverable, and never equal to the plaintext on disk
    expect(decrypt(saved.zernio.api_key)).toBe(API_KEY);
    expect(decrypt(saved.zernio.webhook_secret)).toMatch(/^[a-f0-9]{64}$/);

    const { url, secret } = zernioClient.ensureWebhook.mock.calls[0][0];
    expect(url).toContain(`/zernio-webhook/${accountId}`);
    expect(secret).toBe(decrypt(saved.zernio.webhook_secret));
  });

  it("reuses the webhook secret across reconnects", async () => {
    await request(app).post("/api/zernio/connect").send(CONNECT_BODY);
    const first = await Account.findById(accountId).lean();

    await request(app).post("/api/zernio/connect").send(CONNECT_BODY);
    const second = await Account.findById(accountId).lean();

    expect(decrypt(second.zernio.webhook_secret)).toBe(decrypt(first.zernio.webhook_secret));
    expect(zernioClient.ensureWebhook.mock.calls[1][0].webhookId).toBe("wh_1");
  });

  it("rejects an incomplete body", async () => {
    const res = await request(app)
      .post("/api/zernio/connect")
      .send({ api_key: API_KEY, profile_id: "p1" });

    expect(res.status).toBe(400);
    expect(zernioClient.ensureWebhook).not.toHaveBeenCalled();
  });

  it("surfaces a Zernio auth failure as 502 without persisting anything", async () => {
    zernioClient.ensureWebhook.mockRejectedValue(
      new zernioClient.ZernioApiError(401, "The Zernio API key is invalid or expired."),
    );

    const res = await request(app).post("/api/zernio/connect").send(CONNECT_BODY);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/invalid or expired/i);

    const saved = await Account.findById(accountId).lean();
    expect(saved.zernio?.enabled).toBeFalsy();
  });
});

describe("POST /api/zernio/profiles and /accounts", () => {
  it("lists profiles using a key supplied in the request", async () => {
    const res = await request(app).post("/api/zernio/profiles").send({ api_key: API_KEY });

    expect(res.status).toBe(200);
    expect(res.body.profiles).toEqual([{ id: "p1", name: "Main" }]);
    expect(zernioClient.listProfiles).toHaveBeenCalledWith(API_KEY);
  });

  it("falls back to the stored key once connected", async () => {
    await request(app).post("/api/zernio/connect").send(CONNECT_BODY);

    const res = await request(app).post("/api/zernio/profiles").send({});

    expect(res.status).toBe(200);
    expect(zernioClient.listProfiles).toHaveBeenCalledWith(API_KEY);
  });

  it("400s when no key is available at all", async () => {
    const res = await request(app).post("/api/zernio/profiles").send({});

    expect(res.status).toBe(400);
    expect(zernioClient.listProfiles).not.toHaveBeenCalled();
  });

  it("lists Instagram accounts for a profile", async () => {
    const res = await request(app)
      .post("/api/zernio/accounts")
      .send({ api_key: API_KEY, profile_id: "p1" });

    expect(res.status).toBe(200);
    expect(res.body.accounts[0].ig_user_id).toBe("17841400000000000");
  });
});

describe("DELETE /api/zernio", () => {
  it("clears the stored credentials and disables the connection", async () => {
    await request(app).post("/api/zernio/connect").send(CONNECT_BODY);

    const res = await request(app).delete("/api/zernio");

    expect(res.status).toBe(200);
    const saved = await Account.findById(accountId).lean();
    expect(saved.zernio.enabled).toBe(false);
    expect(saved.zernio.api_key).toBeNull();
    expect(saved.zernio.webhook_secret).toBeNull();
    // Kept on purpose so a later reconnect can adopt the same upstream webhook
    expect(saved.zernio.webhook_id).toBe("wh_1");
  });
});

describe("webhook URL construction", () => {
  const ORIGINAL = process.env.PUBLIC_SERVER_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PUBLIC_SERVER_URL;
    else process.env.PUBLIC_SERVER_URL = ORIGINAL;
  });

  it("uses PUBLIC_SERVER_URL when configured", async () => {
    process.env.PUBLIC_SERVER_URL = "https://api.example.com";

    const res = await request(app).get("/api/zernio/status");

    expect(res.body.webhook_url).toBe(
      `https://api.example.com/zernio-webhook/${accountId}`,
    );
  });

  // Regression: with no env var and a proxy that terminates TLS, req.protocol
  // reports "http" and Zernio would be handed an http webhook URL.
  it("still derives an https URL when no env var is set", async () => {
    delete process.env.PUBLIC_SERVER_URL;

    const res = await request(app).get("/api/zernio/status");

    expect(res.body.webhook_url.startsWith("https://")).toBe(true);
    expect(res.body.webhook_url).toContain(`/zernio-webhook/${accountId}`);
  });
});

const express = require("express");
const mongoose = require("mongoose");
const { createHmac } = require("crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

jest.mock("./instagram-webhook", () => {
  const router = require("express").Router();
  router.processWebhookEvent = jest.fn().mockResolvedValue(undefined);
  return router;
});

const Account = require("../models/Account");
const igWebhook = require("./instagram-webhook");
const zernioWebhookRouter = require("./zernio-webhook");

const SECRET = "s".repeat(64);
const IG_USER_ID = "17841400000000000";
const ZERNIO_ACCOUNT_ID = "zacct_1";

let mongoServer;
let app;
let accountId;

function sign(body, secret = SECRET) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function commentEvent() {
  return {
    id: "evt_1",
    event: "comment.received",
    account: { id: ZERNIO_ACCOUNT_ID, platform: "instagram" },
    comment: {
      id: "comment_1",
      platformPostId: "media_1",
      text: "send me the guide",
      author: { id: "commenter_1", username: "someone" },
    },
  };
}

async function post(id, payload, { signature, secret } = {}) {
  const raw = JSON.stringify(payload);
  const req = request(app).post(`/zernio-webhook/${id}`).set("Content-Type", "application/json");
  const sig = signature !== undefined ? signature : sign(raw, secret || SECRET);
  if (sig !== null) req.set("x-zernio-signature", sig);
  return req.send(raw);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(
    "/zernio-webhook",
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
    zernioWebhookRouter,
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await Account.deleteMany({});
  const account = await Account.create({
    ghl: "loc_test",
    name: "Test",
    zernio: {
      api_key: "key",
      profile_id: "p1",
      zernio_account_id: ZERNIO_ACCOUNT_ID,
      ig_user_id: IG_USER_ID,
      webhook_secret: SECRET,
      enabled: true,
    },
  });
  accountId = account._id.toString();
});

describe("POST /zernio-webhook/:accountId", () => {
  it("accepts a correctly signed event and forwards the normalized payload", async () => {
    const res = await post(accountId, commentEvent());

    expect(res.status).toBe(200);
    expect(igWebhook.processWebhookEvent).toHaveBeenCalledTimes(1);

    const payload = igWebhook.processWebhookEvent.mock.calls[0][0];
    expect(payload.object).toBe("instagram");
    expect(payload.entry[0].id).toBe(IG_USER_ID);
    expect(payload.entry[0].changes[0].field).toBe("comments");
    expect(payload.entry[0].changes[0].value.id).toBe("comment_1");
  });

  it("rejects a bad signature", async () => {
    const res = await post(accountId, commentEvent(), { secret: "x".repeat(64) });

    expect(res.status).toBe(401);
    expect(igWebhook.processWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects a missing signature", async () => {
    const res = await post(accountId, commentEvent(), { signature: null });

    expect(res.status).toBe(401);
    expect(igWebhook.processWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects a replayed signature over a different body", async () => {
    const signature = sign(JSON.stringify(commentEvent()));
    const tampered = commentEvent();
    tampered.comment.text = "different text";

    const res = await post(accountId, tampered, { signature });

    expect(res.status).toBe(401);
    expect(igWebhook.processWebhookEvent).not.toHaveBeenCalled();
  });

  it("404s for a malformed account id", async () => {
    const res = await post("not-an-objectid", commentEvent());
    expect(res.status).toBe(404);
  });

  it("404s for an account with no Zernio connection", async () => {
    const other = await Account.create({ ghl: "loc_other", name: "Other" });
    const res = await post(other._id.toString(), commentEvent());

    expect(res.status).toBe(404);
    expect(igWebhook.processWebhookEvent).not.toHaveBeenCalled();
  });

  it("404s once the connection is disabled", async () => {
    await Account.updateOne({ _id: accountId }, { $set: { "zernio.enabled": false } });
    const res = await post(accountId, commentEvent());

    expect(res.status).toBe(404);
    expect(igWebhook.processWebhookEvent).not.toHaveBeenCalled();
  });

  it("acknowledges but drops an event for a different Zernio account", async () => {
    const payload = commentEvent();
    payload.account.id = "zacct_someone_else";

    const res = await post(accountId, payload);

    expect(res.status).toBe(200);
    expect(igWebhook.processWebhookEvent).not.toHaveBeenCalled();
  });

  it("acknowledges but drops an event type we do not act on", async () => {
    const payload = commentEvent();
    payload.event = "comment.deleted";

    const res = await post(accountId, payload);

    expect(res.status).toBe(200);
    expect(igWebhook.processWebhookEvent).not.toHaveBeenCalled();
  });
});

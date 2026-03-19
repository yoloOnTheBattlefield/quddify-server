const request = require("supertest");
const express = require("express");

jest.mock("../models/PushSubscription");
const PushSubscription = require("../models/PushSubscription");

const router = require("./push-subscriptions");

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.account = { _id: "acc123" };
  next();
});
app.use("/api/push-subscriptions", router);

describe("GET /api/push-subscriptions/vapid-public-key", () => {
  it("returns 503 when VAPID keys not configured", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const res = await request(app).get("/api/push-subscriptions/vapid-public-key");
    expect(res.status).toBe(503);
  });

  it("returns the public key when configured", async () => {
    process.env.VAPID_PUBLIC_KEY = "testkey";
    const res = await request(app).get("/api/push-subscriptions/vapid-public-key");
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe("testkey");
  });
});

describe("POST /api/push-subscriptions", () => {
  it("returns 400 when payload is incomplete", async () => {
    const res = await request(app).post("/api/push-subscriptions").send({ endpoint: "https://example.com" });
    expect(res.status).toBe(400);
  });

  it("upserts and returns success", async () => {
    PushSubscription.findOneAndUpdate = jest.fn().mockResolvedValue({});
    const res = await request(app)
      .post("/api/push-subscriptions")
      .send({ endpoint: "https://fcm.example.com", keys: { p256dh: "abc", auth: "xyz" } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(PushSubscription.findOneAndUpdate).toHaveBeenCalled();
  });
});

describe("DELETE /api/push-subscriptions", () => {
  it("returns 400 when endpoint is missing", async () => {
    const res = await request(app).delete("/api/push-subscriptions").send({});
    expect(res.status).toBe(400);
  });

  it("deletes and returns success", async () => {
    PushSubscription.deleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });
    const res = await request(app)
      .delete("/api/push-subscriptions")
      .send({ endpoint: "https://fcm.example.com" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

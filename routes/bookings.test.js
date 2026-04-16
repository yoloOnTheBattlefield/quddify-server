const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Booking = require("../models/Booking");
const OutboundLead = require("../models/OutboundLead");

const bookingsRouter = require("./bookings");

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
    req.user = { _id: "user1", first_name: "Test", last_name: "User", email: "test@test.com" };
    next();
  });
  app.use("/api/bookings", bookingsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Booking.deleteMany({});
  await OutboundLead.deleteMany({});
});

describe("POST /api/bookings", () => {
  it("creates a booking", async () => {
    const res = await request(app)
      .post("/api/bookings")
      .send({ booking_date: "2026-04-01T10:00:00Z", contact_name: "John", source: "outbound" });

    expect(res.status).toBe(201);
    expect(res.body.contact_name).toBe("John");
    expect(res.body.status).toBe("scheduled");
    expect(res.body.account_id).toBe(accountId.toString());
  });

  it("returns 400 without booking_date", async () => {
    const res = await request(app)
      .post("/api/bookings")
      .send({ contact_name: "John" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/bookings", () => {
  it("returns paginated bookings", async () => {
    await Booking.create({
      account_id: accountId,
      booking_date: new Date(),
      contact_name: "Lead 1",
    });

    const res = await request(app).get("/api/bookings");
    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it("filters by status", async () => {
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "completed" });
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "scheduled" });

    const res = await request(app).get("/api/bookings?status=completed");
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].status).toBe("completed");
  });
});

describe("PATCH /api/bookings/:id", () => {
  it("updates booking and auto-sets completed_at", async () => {
    const booking = await Booking.create({
      account_id: accountId,
      booking_date: new Date(),
      contact_name: "Test",
    });

    const res = await request(app)
      .patch(`/api/bookings/${booking._id}`)
      .send({ status: "completed", cash_collected: 500 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.completed_at).toBeTruthy();
    expect(res.body.cash_collected).toBe(500);
  });

  it("auto-sets cancelled_at when cancelled", async () => {
    const booking = await Booking.create({
      account_id: accountId,
      booking_date: new Date(),
    });

    const res = await request(app)
      .patch(`/api/bookings/${booking._id}`)
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(res.body.cancelled_at).toBeTruthy();
  });

  it("returns 404 for wrong account", async () => {
    const other = new mongoose.Types.ObjectId();
    const booking = await Booking.create({
      account_id: other,
      booking_date: new Date(),
    });

    const res = await request(app)
      .patch(`/api/bookings/${booking._id}`)
      .send({ status: "completed" });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/bookings/:id", () => {
  it("deletes a booking", async () => {
    const booking = await Booking.create({
      account_id: accountId,
      booking_date: new Date(),
    });

    const res = await request(app).delete(`/api/bookings/${booking._id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const count = await Booking.countDocuments();
    expect(count).toBe(0);
  });
});

describe("GET /api/bookings/stats", () => {
  it("returns aggregate stats", async () => {
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "scheduled" });
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "completed" });

    const res = await request(app).get("/api/bookings/stats");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.scheduled).toBe(1);
    expect(res.body.completed).toBe(1);
  });
});

describe("GET /api/bookings/analytics", () => {
  it("returns analytics data", async () => {
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "completed", cash_collected: 1000 });
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "no_show" });

    const res = await request(app).get("/api/bookings/analytics");
    expect(res.status).toBe(200);
    expect(res.body.close_rate).toBe(50);
    expect(res.body.show_up_rate).toBe(50);
    expect(res.body.avg_cash_collected).toBe(1000);
  });

  it("returns by_channel breakdown grouped by utm_source", async () => {
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "completed", utm_source: "ig", cash_collected: 2000 });
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "no_show", utm_source: "ig" });
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "completed", utm_source: "yt", cash_collected: 5000 });
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "completed", utm_source: "li" });

    const res = await request(app).get("/api/bookings/analytics");
    expect(res.status).toBe(200);
    expect(res.body.by_channel).toBeDefined();
    expect(res.body.by_channel.length).toBeGreaterThanOrEqual(3);

    const ig = res.body.by_channel.find((c) => c.channel === "Instagram");
    expect(ig).toBeTruthy();
    expect(ig.bookings).toBe(2);
    expect(ig.completed).toBe(1);
    expect(ig.no_show).toBe(1);
    expect(ig.show_rate).toBe(50);
    expect(ig.revenue).toBe(2000);

    const yt = res.body.by_channel.find((c) => c.channel === "YouTube");
    expect(yt).toBeTruthy();
    expect(yt.bookings).toBe(1);
    expect(yt.completed).toBe(1);
    expect(yt.close_rate).toBe(100);

    const li = res.body.by_channel.find((c) => c.channel === "LinkedIn");
    expect(li).toBeTruthy();
    expect(li.bookings).toBe(1);
  });

  it("falls back to source field when no utm_source", async () => {
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "completed", source: "inbound" });
    await Booking.create({ account_id: accountId, booking_date: new Date(), status: "completed", source: "outbound" });

    const res = await request(app).get("/api/bookings/analytics");
    const channels = res.body.by_channel.map((c) => c.channel);
    expect(channels).toContain("Direct");
    expect(channels).toContain("Outbound DM");
  });

  it("filters by date range", async () => {
    await Booking.create({ account_id: accountId, booking_date: new Date("2026-03-01"), status: "completed", utm_source: "ig" });
    await Booking.create({ account_id: accountId, booking_date: new Date("2026-04-01"), status: "completed", utm_source: "ig" });

    const res = await request(app).get("/api/bookings/analytics?start_date=2026-03-15&end_date=2026-04-15");
    expect(res.body.total).toBe(1);
    expect(res.body.by_channel).toHaveLength(1);
  });
});

describe("POST /api/bookings/sync", () => {
  it("creates bookings for booked outbound leads", async () => {
    await OutboundLead.create({
      account_id: accountId,
      followingKey: "test::source",
      username: "testlead",
      booked: true,
      booked_at: new Date(),
    });

    const res = await request(app).post("/api/bookings/sync");
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);

    // Running again should not duplicate
    const res2 = await request(app).post("/api/bookings/sync");
    expect(res2.body.synced).toBe(0);
  });
});

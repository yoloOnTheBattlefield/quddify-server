const express = require("express");
const request = require("supertest");
const { z } = require("zod");
const validate = require("./validate");

// -- test schemas --
const { loginSchema, registerSchema } = require("../schemas/accounts");
const { webhookSchema } = require("../schemas/manychat");

function buildApp(method, path, schema) {
  const app = express();
  app.use(express.json());
  if (method === "post") {
    app.post(path, validate(schema), (req, res) => res.json({ ok: true }));
  } else if (method === "patch") {
    app.patch(path, validate(schema), (req, res) => res.json({ ok: true }));
  }
  return app;
}

// ---- validate middleware ----

describe("validate middleware", () => {
  it("returns 400 with details on validation failure", async () => {
    const schema = z.object({
      body: z.object({ name: z.string() }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    });
    const app = buildApp("post", "/test", schema);

    const res = await request(app).post("/test").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(res.body.details).toBeDefined();
    expect(res.body.details.length).toBeGreaterThan(0);
    expect(res.body.details[0].path).toContain("name");
  });

  it("passes through on valid input", async () => {
    const schema = z.object({
      body: z.object({ name: z.string() }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    });
    const app = buildApp("post", "/test", schema);

    const res = await request(app).post("/test").send({ name: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ---- accounts schemas ----

describe("accounts schemas", () => {
  describe("loginSchema", () => {
    const app = buildApp("post", "/login", loginSchema);

    it("rejects empty body", async () => {
      const res = await request(app).post("/login").send({});
      expect(res.status).toBe(400);
    });

    it("rejects missing password", async () => {
      const res = await request(app).post("/login").send({ email: "a@b.com" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid email", async () => {
      const res = await request(app).post("/login").send({ email: "notanemail", password: "pass" });
      expect(res.status).toBe(400);
      expect(res.body.details.some((d) => d.message.toLowerCase().includes("email"))).toBe(true);
    });

    it("accepts valid login", async () => {
      const res = await request(app).post("/login").send({ email: "a@b.com", password: "pass123" });
      expect(res.status).toBe(200);
    });
  });

  describe("registerSchema", () => {
    const app = buildApp("post", "/register", registerSchema);

    it("rejects password shorter than 6 chars", async () => {
      const res = await request(app).post("/register").send({ email: "a@b.com", password: "abc" });
      expect(res.status).toBe(400);
      expect(res.body.details.some((d) => d.message.toLowerCase().includes("6"))).toBe(true);
    });

    it("accepts valid registration with optional fields", async () => {
      const res = await request(app).post("/register").send({
        email: "user@example.com",
        password: "secret123",
        first_name: "John",
      });
      expect(res.status).toBe(200);
    });
  });
});

// ---- outbound-leads schemas ----

describe("manychat schemas", () => {
  describe("webhookSchema", () => {
    const app = buildApp("post", "/webhook", webhookSchema);

    it("rejects missing ig_username", async () => {
      const res = await request(app).post("/webhook").send({});
      expect(res.status).toBe(400);
    });

    it("rejects empty ig_username", async () => {
      const res = await request(app).post("/webhook").send({ ig_username: "" });
      expect(res.status).toBe(400);
    });

    it("accepts valid webhook with only ig_username", async () => {
      const res = await request(app).post("/webhook").send({ ig_username: "testuser" });
      expect(res.status).toBe(200);
    });

    it("accepts full webhook body", async () => {
      const res = await request(app).post("/webhook").send({
        ig_username: "testuser",
        first_name: "John",
        last_name: "Doe",
        full_name: "John Doe",
        trigger_type: "dm",
        post_url: "https://instagram.com/p/abc",
      });
      expect(res.status).toBe(200);
    });
  });
});

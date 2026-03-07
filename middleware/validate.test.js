const express = require("express");
const request = require("supertest");
const { z } = require("zod");
const validate = require("./validate");

// -- test schemas --
const { loginSchema, registerSchema } = require("../schemas/accounts");
const { bulkDeleteSchema, patchLeadSchema } = require("../schemas/outbound-leads");
const { createCampaignSchema, patchCampaignSchema } = require("../schemas/campaigns");
const { startDeepScrapeSchema } = require("../schemas/deep-scrape");
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

describe("outbound-leads schemas", () => {
  describe("bulkDeleteSchema", () => {
    const app = buildApp("post", "/bulk-delete", bulkDeleteSchema);

    it("rejects empty body (no ids or all+filters)", async () => {
      const res = await request(app).post("/bulk-delete").send({});
      expect(res.status).toBe(400);
    });

    it("accepts ids array", async () => {
      const res = await request(app).post("/bulk-delete").send({ ids: ["abc123"] });
      expect(res.status).toBe(200);
    });

    it("accepts all+filters", async () => {
      const res = await request(app).post("/bulk-delete").send({ all: true, filters: { source: "test" } });
      expect(res.status).toBe(200);
    });
  });

  describe("patchLeadSchema", () => {
    const app = express();
    app.use(express.json());
    app.patch("/leads/:id", validate(patchLeadSchema), (req, res) => res.json({ ok: true }));

    it("accepts valid patch with boolean fields", async () => {
      const res = await request(app).patch("/leads/abc123").send({ replied: true });
      expect(res.status).toBe(200);
    });

    it("accepts empty body (passthrough)", async () => {
      const res = await request(app).patch("/leads/abc123").send({});
      expect(res.status).toBe(200);
    });
  });
});

// ---- campaigns schemas ----

describe("campaigns schemas", () => {
  describe("createCampaignSchema", () => {
    const app = buildApp("post", "/campaigns", createCampaignSchema);

    it("rejects missing name", async () => {
      const res = await request(app).post("/campaigns").send({});
      expect(res.status).toBe(400);
    });

    it("rejects invalid mode", async () => {
      const res = await request(app).post("/campaigns").send({ name: "Test", mode: "invalid" });
      expect(res.status).toBe(400);
    });

    it("accepts valid campaign with schedule", async () => {
      const res = await request(app).post("/campaigns").send({
        name: "My Campaign",
        mode: "auto",
        schedule: { active_hours_start: 9, active_hours_end: 21 },
      });
      expect(res.status).toBe(200);
    });

    it("rejects schedule with invalid active_hours_start", async () => {
      const res = await request(app).post("/campaigns").send({
        name: "Test",
        schedule: { active_hours_start: 25 },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("patchCampaignSchema", () => {
    const app = express();
    app.use(express.json());
    app.patch("/campaigns/:id", validate(patchCampaignSchema), (req, res) => res.json({ ok: true }));

    it("accepts partial update", async () => {
      const res = await request(app).patch("/campaigns/abc123").send({ name: "Updated" });
      expect(res.status).toBe(200);
    });

    it("rejects empty name string", async () => {
      const res = await request(app).patch("/campaigns/abc123").send({ name: "" });
      expect(res.status).toBe(400);
    });
  });
});

// ---- deep-scrape schema ----

describe("deep-scrape schemas", () => {
  describe("startDeepScrapeSchema", () => {
    const app = buildApp("post", "/start", startDeepScrapeSchema);

    it("rejects body with neither seed_usernames nor direct_urls", async () => {
      const res = await request(app).post("/start").send({ name: "test" });
      expect(res.status).toBe(400);
    });

    it("rejects empty arrays", async () => {
      const res = await request(app).post("/start").send({ seed_usernames: [], direct_urls: [] });
      expect(res.status).toBe(400);
    });

    it("accepts seed_usernames", async () => {
      const res = await request(app).post("/start").send({ seed_usernames: ["user1"] });
      expect(res.status).toBe(200);
    });

    it("accepts direct_urls", async () => {
      const res = await request(app).post("/start").send({ direct_urls: ["https://instagram.com/reel/abc"] });
      expect(res.status).toBe(200);
    });

    it("accepts full body with optional fields", async () => {
      const res = await request(app).post("/start").send({
        name: "My Scrape",
        mode: "research",
        seed_usernames: ["user1", "user2"],
        scrape_type: "posts",
        reel_limit: 5,
        comment_limit: 50,
        min_followers: 500,
        is_recurring: true,
        repeat_interval_days: 7,
      });
      expect(res.status).toBe(200);
    });
  });
});

// ---- manychat schema ----

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

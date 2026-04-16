const express = require("express");
const request = require("supertest");

const aiUsageRouter = require("./ai-usage");

// Mock the crypto module
jest.mock("../utils/crypto", () => ({
  decrypt: (val) => (val ? `decrypted_${val}` : null),
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

let app;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.account = {
      _id: "acc123",
      openai_token: null,
      claude_token: null,
      gemini_token: null,
    };
    next();
  });
  app.use("/api/ai-usage", aiUsageRouter);
});

afterEach(() => {
  mockFetch.mockReset();
});

describe("GET /api/ai-usage", () => {
  it("returns empty object when no tokens are set", async () => {
    const res = await request(app).get("/api/ai-usage");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches OpenAI usage via org costs endpoint", async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.account = {
        _id: "acc123",
        openai_token: "enc_openai_key",
        claude_token: null,
        gemini_token: null,
      };
      next();
    });
    app.use("/api/ai-usage", aiUsageRouter);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            results: [
              { amount: { value: 1250 }, line_item: "completions" },
              { amount: { value: 350 }, line_item: "embeddings" },
            ],
          },
        ],
      }),
    });

    const res = await request(app).get("/api/ai-usage");
    expect(res.status).toBe(200);
    expect(res.body.openai).toBeDefined();
    expect(res.body.openai.totalUsageUsd).toBe(16);
    expect(res.body.openai.source).toBe("organization");
    expect(res.body.openai.period).toBe("current month");
  });

  it("falls back to credit grants when org costs fails", async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.account = {
        _id: "acc123",
        openai_token: "enc_openai_key",
        claude_token: null,
        gemini_token: null,
      };
      next();
    });
    app.use("/api/ai-usage", aiUsageRouter);

    // First call (org costs) fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    // Second call (credit grants) succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        total_granted: 50.0,
        total_used: 12.5,
        total_available: 37.5,
      }),
    });

    const res = await request(app).get("/api/ai-usage");
    expect(res.status).toBe(200);
    expect(res.body.openai.source).toBe("credits");
    expect(res.body.openai.totalGranted).toBe(50.0);
    expect(res.body.openai.totalUsed).toBe(12.5);
    expect(res.body.openai.totalAvailable).toBe(37.5);
  });

  it("returns error when both OpenAI endpoints fail", async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.account = {
        _id: "acc123",
        openai_token: "enc_openai_key",
        claude_token: null,
        gemini_token: null,
      };
      next();
    });
    app.use("/api/ai-usage", aiUsageRouter);

    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const res = await request(app).get("/api/ai-usage");
    expect(res.status).toBe(200);
    expect(res.body.openai.error).toBeDefined();
  });

  it("fetches Anthropic usage when claude token is set", async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.account = {
        _id: "acc123",
        openai_token: null,
        claude_token: "enc_claude_key",
        gemini_token: null,
      };
      next();
    });
    app.use("/api/ai-usage", aiUsageRouter);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        total_usage_usd: 8.42,
        total_input_tokens: 1500000,
        total_output_tokens: 250000,
      }),
    });

    const res = await request(app).get("/api/ai-usage");
    expect(res.status).toBe(200);
    expect(res.body.claude.totalUsageUsd).toBe(8.42);
    expect(res.body.claude.inputTokens).toBe(1500000);
    expect(res.body.claude.outputTokens).toBe(250000);
    expect(res.body.claude.source).toBe("usage");
  });

  it("returns error for Anthropic when usage endpoint returns 403", async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.account = {
        _id: "acc123",
        openai_token: null,
        claude_token: "enc_claude_key",
        gemini_token: null,
      };
      next();
    });
    app.use("/api/ai-usage", aiUsageRouter);

    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const res = await request(app).get("/api/ai-usage");
    expect(res.status).toBe(200);
    expect(res.body.claude.error).toContain("Admin API key");
  });

  it("returns error for Gemini noting no billing API exists", async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.account = {
        _id: "acc123",
        openai_token: null,
        claude_token: null,
        gemini_token: "enc_gemini_key",
      };
      next();
    });
    app.use("/api/ai-usage", aiUsageRouter);

    // Gemini model listing succeeds (key is valid)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [] }),
    });

    const res = await request(app).get("/api/ai-usage");
    expect(res.status).toBe(200);
    expect(res.body.gemini.error).toContain("not provide a billing API");
  });

  it("fetches all providers in parallel when all tokens are set", async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.account = {
        _id: "acc123",
        openai_token: "enc_openai",
        claude_token: "enc_claude",
        gemini_token: "enc_gemini",
      };
      next();
    });
    app.use("/api/ai-usage", aiUsageRouter);

    // OpenAI org costs
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ results: [{ amount: { value: 500 } }] }],
      }),
    });
    // Anthropic usage
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        total_usage_usd: 3.0,
        total_input_tokens: 100000,
        total_output_tokens: 50000,
      }),
    });
    // Gemini models
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [] }),
    });

    const res = await request(app).get("/api/ai-usage");
    expect(res.status).toBe(200);
    expect(res.body.openai).toBeDefined();
    expect(res.body.claude).toBeDefined();
    expect(res.body.gemini).toBeDefined();
  });

  it("handles network errors gracefully", async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.account = {
        _id: "acc123",
        openai_token: "enc_openai",
        claude_token: null,
        gemini_token: null,
      };
      next();
    });
    app.use("/api/ai-usage", aiUsageRouter);

    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await request(app).get("/api/ai-usage");
    expect(res.status).toBe(200);
    expect(res.body.openai.error).toContain("Failed to connect");
  });
});

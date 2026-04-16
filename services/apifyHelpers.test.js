const {
  APIFY_MEMORY_MB,
  APIFY_MAX_CHARGE_USD,
  APIFY_BASE,
  REEL_SCRAPER,
  POST_SCRAPER,
  COMMENT_SCRAPER,
  PROFILE_SCRAPER,
  LIKER_SCRAPER,
  FOLLOWERS_SCRAPER,
  ApifyLimitError,
  startApifyRun,
  fetchApifyUsage,
  getDatasetItems,
  abortApifyRun,
} = require("./apifyHelpers");

// ─── Constants ──────────────────────────────────────────────────────────
describe("apifyHelpers exports", () => {
  it("exports APIFY_MEMORY_MB as a number", () => {
    expect(typeof APIFY_MEMORY_MB).toBe("number");
    expect(APIFY_MEMORY_MB).toBe(4096);
  });

  it("exports APIFY_MAX_CHARGE_USD as a number", () => {
    expect(typeof APIFY_MAX_CHARGE_USD).toBe("number");
    expect(APIFY_MAX_CHARGE_USD).toBe(10);
  });

  it("exports APIFY_BASE url", () => {
    expect(APIFY_BASE).toBe("https://api.apify.com/v2");
  });

  it("exports all actor ID constants", () => {
    expect(REEL_SCRAPER).toBeDefined();
    expect(POST_SCRAPER).toBeDefined();
    expect(COMMENT_SCRAPER).toBeDefined();
    expect(PROFILE_SCRAPER).toBeDefined();
    expect(LIKER_SCRAPER).toBeDefined();
    expect(FOLLOWERS_SCRAPER).toBeDefined();
  });
});

// ─── ApifyLimitError ────────────────────────────────────────────────────
describe("ApifyLimitError", () => {
  it("is an instance of Error", () => {
    const err = new ApifyLimitError("limit hit");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApifyLimitError);
  });

  it("has the correct name and message", () => {
    const err = new ApifyLimitError("monthly limit");
    expect(err.name).toBe("ApifyLimitError");
    expect(err.message).toBe("monthly limit");
  });
});

// ─── startApifyRun ──────────────────────────────────────────────────────
describe("startApifyRun", () => {
  afterEach(() => jest.restoreAllMocks());

  it("sends POST with memory and maxCharge query params", async () => {
    const mockRun = { id: "run123", status: "RUNNING" };
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockRun }),
    });

    const result = await startApifyRun("actor1", { foo: "bar" }, "tok_abc");
    expect(result).toEqual(mockRun);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain(`memory=${APIFY_MEMORY_MB}`);
    expect(url).toContain(`maxTotalChargeUsd=${APIFY_MAX_CHARGE_USD}`);
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok_abc");
    expect(JSON.parse(opts.body)).toEqual({ foo: "bar" });
  });

  it("throws ApifyLimitError on 401/402/403", async () => {
    for (const status of [401, 402, 403]) {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status,
        text: async () => "forbidden",
      });
      await expect(startApifyRun("a", {}, "t")).rejects.toThrow(ApifyLimitError);
      jest.restoreAllMocks();
    }
  });

  it("throws ApifyLimitError when response body contains usage-limit keywords", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "monthly-usage-hard-limit exceeded",
    });
    await expect(startApifyRun("a", {}, "t")).rejects.toThrow(ApifyLimitError);
  });

  it("throws generic Error on other failures", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });
    await expect(startApifyRun("a", {}, "t")).rejects.toThrow("Apify start failed (500)");
  });
});

// ─── fetchApifyUsage ────────────────────────────────────────────────────
describe("fetchApifyUsage", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns usage data on success", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          current: { monthlyUsageUsd: 5.5 },
          limits: { maxMonthlyUsageUsd: 50 },
          monthlyUsageCycle: { endAt: "2026-05-01" },
        },
      }),
    });

    const usage = await fetchApifyUsage("tok");
    expect(usage).toEqual({
      usedUsd: 5.5,
      limitUsd: 50,
      resetAt: "2026-05-01",
    });
  });

  it("returns null on non-ok response", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: false });
    expect(await fetchApifyUsage("tok")).toBeNull();
  });

  it("returns null on network error", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("network"));
    expect(await fetchApifyUsage("tok")).toBeNull();
  });
});

// ─── getDatasetItems ────────────────────────────────────────────────────
describe("getDatasetItems", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns empty array when datasetId is falsy", async () => {
    expect(await getDatasetItems(null, "tok")).toEqual([]);
    expect(await getDatasetItems("", "tok")).toEqual([]);
  });

  it("fetches and returns items", async () => {
    const items = [{ id: 1 }, { id: 2 }];
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => items,
    });
    expect(await getDatasetItems("ds1", "tok")).toEqual(items);
  });

  it("returns empty array on failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: false });
    expect(await getDatasetItems("ds1", "tok")).toEqual([]);
  });
});

// ─── abortApifyRun ──────────────────────────────────────────────────────
describe("abortApifyRun", () => {
  afterEach(() => jest.restoreAllMocks());

  it("sends POST to abort endpoint", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true });
    await abortApifyRun("run1", "tok");
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe(`${APIFY_BASE}/actor-runs/run1/abort`);
    expect(opts.method).toBe("POST");
  });

  it("does not throw on network error", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("fail"));
    await expect(abortApifyRun("run1", "tok")).resolves.toBeUndefined();
  });
});

const { reportErrorToClickUp } = require("./clickupErrorReporter");

// Save originals
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.CLICKUP_API_TOKEN = "test-token";
  process.env.CLICKUP_ERROR_LIST_ID = "123456";
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

describe("reportErrorToClickUp", () => {
  it("creates a ClickUp task for a 500 error", async () => {
    await reportErrorToClickUp({
      method: "GET",
      url: "/outbound-leads/abc",
      status: 500,
      message: "Cast to ObjectId failed",
      stack: "Error: Cast to ObjectId failed\n    at ...",
      reqId: "req-123",
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOpts] = global.fetch.mock.calls[0];
    expect(fetchUrl).toBe("https://api.clickup.com/api/v2/list/123456/task");
    expect(fetchOpts.method).toBe("POST");

    const body = JSON.parse(fetchOpts.body);
    expect(body.name).toContain("[500] GET /outbound-leads/abc");
    expect(body.description).toContain("Cast to ObjectId failed");
    expect(body.status).toBe("to do");
    expect(body.tags).toEqual(["bug", "auto-reported"]);
  });

  it("skips reporting when env vars are missing", async () => {
    delete process.env.CLICKUP_API_TOKEN;
    delete process.env.CLICKUP_ERROR_LIST_ID;

    // Re-require to pick up missing env
    jest.resetModules();
    const { reportErrorToClickUp: report } = require("./clickupErrorReporter");

    await report({ method: "GET", url: "/test", status: 500, message: "err" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("deduplicates identical errors within the window", async () => {
    const params = {
      method: "GET",
      url: "/same-route",
      status: 500,
      message: "Same error",
    };

    await reportErrorToClickUp(params);
    await reportErrorToClickUp(params);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

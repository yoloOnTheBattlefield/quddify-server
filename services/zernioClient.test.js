const zernioClient = require("./zernioClient");

// Deliberately not shaped like a real key, so secret scanners stay quiet.
const API_KEY = "fake-api-key-for-tests";

let calls;

function mockFetch(responder) {
  calls = [];
  global.fetch = jest.fn(async (url, options) => {
    calls.push({
      url: String(url),
      method: options?.method || "GET",
      headers: options?.headers || {},
      body: options?.body ? JSON.parse(options.body) : undefined,
    });
    return responder(String(url), options);
  });
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("zernioRequest", () => {
  it("hits the v1 base URL with a bearer token", async () => {
    mockFetch(() => jsonResponse({ profiles: [] }));

    await zernioClient.zernioRequest({ apiKey: API_KEY, path: "/profiles" });

    expect(calls[0].url).toBe("https://zernio.com/api/v1/profiles");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
  });

  it("sends an Idempotency-Key only when given one", async () => {
    mockFetch(() => jsonResponse({}));

    await zernioClient.zernioRequest({ apiKey: API_KEY, path: "/x", idempotencyKey: "abc" });
    expect(calls[0].headers["Idempotency-Key"]).toBe("abc");

    await zernioClient.zernioRequest({ apiKey: API_KEY, path: "/x" });
    expect(calls[1].headers["Idempotency-Key"]).toBeUndefined();
  });

  it("rejects a path that is not a single-slash absolute path", async () => {
    mockFetch(() => jsonResponse({}));
    await expect(
      zernioClient.zernioRequest({ apiKey: API_KEY, path: "//evil.com" }),
    ).rejects.toThrow("Invalid Zernio API path");
    await expect(
      zernioClient.zernioRequest({ apiKey: API_KEY, path: "profiles" }),
    ).rejects.toThrow("Invalid Zernio API path");
  });

  it("throws without an API key", async () => {
    await expect(zernioClient.zernioRequest({ apiKey: null, path: "/x" })).rejects.toThrow(
      /No Zernio API key/,
    );
  });

  it.each([
    [401, /invalid or expired/i],
    [402, /Inbox access/i],
    [403, /unrestricted, read-write/i],
    [429, /rate limit/i],
  ])("classifies HTTP %s without leaking the body", async (status, pattern) => {
    mockFetch(() => jsonResponse({ secret: "should-never-surface" }, status));

    const err = await zernioClient
      .zernioRequest({ apiKey: API_KEY, path: "/x" })
      .catch((e) => e);

    expect(err.status).toBe(status);
    expect(err.message).toMatch(pattern);
    expect(err.message).not.toMatch(/should-never-surface/);
  });

  it("returns undefined on 204", async () => {
    mockFetch(() => ({ ok: true, status: 204, json: async () => ({}) }));
    await expect(zernioClient.zernioRequest({ apiKey: API_KEY, path: "/x" })).resolves.toBeUndefined();
  });

  it("surfaces a network failure as 502", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const err = await zernioClient.zernioRequest({ apiKey: API_KEY, path: "/x" }).catch((e) => e);
    expect(err.status).toBe(502);
  });
});

describe("listInstagramAccounts", () => {
  it("keeps only active instagram accounts on the requested profile", async () => {
    mockFetch(() =>
      jsonResponse({
        accounts: [
          { _id: "a1", platform: "instagram", profileId: "p1", platformUserId: "ig1", username: "keep" },
          { _id: "a2", platform: "facebook", profileId: "p1", platformUserId: "fb1", username: "wrong-platform" },
          { _id: "a3", platform: "instagram", profileId: "p2", platformUserId: "ig3", username: "wrong-profile" },
          { _id: "a4", platform: "instagram", profileId: "p1", platformUserId: "ig4", username: "inactive", isActive: false },
          { _id: "a5", platform: "instagram", profileId: "p1", username: "no-platform-id" },
          { _id: "a6", platform: "instagram", profileId: { _id: "p1" }, platformUserId: "ig6", username: "nested-profile" },
        ],
      }),
    );

    const accounts = await zernioClient.listInstagramAccounts({ apiKey: API_KEY, profileId: "p1" });

    expect(accounts.map((a) => a.username)).toEqual(["keep", "nested-profile"]);
    expect(accounts[0]).toEqual({ id: "a1", ig_user_id: "ig1", username: "keep", name: null });
  });

  it("url-encodes the profile id", async () => {
    mockFetch(() => jsonResponse({ accounts: [] }));
    await zernioClient.listInstagramAccounts({ apiKey: API_KEY, profileId: "p 1/x" });
    expect(calls[0].url).toContain("profileId=p%201%2Fx");
  });
});

describe("ensureWebhook", () => {
  const url = "https://crm.test/zernio-webhook/acct1";

  it("creates a webhook when none matches", async () => {
    mockFetch((requestUrl, options) => {
      if (options?.method === "POST") return jsonResponse({ webhook: { _id: "wh_new" } });
      return jsonResponse({ webhooks: [] });
    });

    const id = await zernioClient.ensureWebhook({ apiKey: API_KEY, url, secret: "s" });

    expect(id).toBe("wh_new");
    const post = calls.find((c) => c.method === "POST");
    expect(post.body).toEqual({
      name: "Quddify",
      url,
      secret: "s",
      events: ["comment.received", "message.received", "message.read"],
      isActive: true,
    });
  });

  it("updates in place when the stored id still exists", async () => {
    mockFetch((_u, options) => {
      if (options?.method === "PUT") return jsonResponse({});
      return jsonResponse({ webhooks: [{ _id: "wh_old", url: "https://old.test/hook" }] });
    });

    const id = await zernioClient.ensureWebhook({
      apiKey: API_KEY,
      url,
      secret: "s",
      webhookId: "wh_old",
    });

    expect(id).toBe("wh_old");
    const put = calls.find((c) => c.method === "PUT");
    expect(put.body._id).toBe("wh_old");
    expect(put.body.url).toBe(url);
  });

  it("adopts an existing webhook matching the URL, so reconnects do not duplicate", async () => {
    mockFetch((_u, options) => {
      if (options?.method === "PUT") return jsonResponse({});
      return jsonResponse({ webhooks: [{ _id: "wh_same_url", url }] });
    });

    const id = await zernioClient.ensureWebhook({ apiKey: API_KEY, url, secret: "s" });

    expect(id).toBe("wh_same_url");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("sends", () => {
  beforeEach(() => mockFetch(() => jsonResponse({ ok: true })));

  it("builds the private-reply path from post and comment ids", async () => {
    await zernioClient.sendPrivateReply({
      apiKey: API_KEY,
      zernioAccountId: "zacct_1",
      postId: "media_1",
      commentId: "comment_1",
      message: "hi",
    });

    expect(calls[0].url).toBe(
      "https://zernio.com/api/v1/inbox/comments/media_1/comment_1/private-reply",
    );
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ accountId: "zacct_1", message: "hi" });
  });

  it("falls back to the comment id when the post id is unknown", async () => {
    await zernioClient.sendPrivateReply({
      apiKey: API_KEY,
      zernioAccountId: "zacct_1",
      postId: null,
      commentId: "comment_1",
      message: "hi",
    });

    expect(calls[0].url).toContain("/inbox/comments/comment_1/comment_1/private-reply");
  });

  it("posts a public reply with the comment id in the body", async () => {
    await zernioClient.sendPublicReply({
      apiKey: API_KEY,
      zernioAccountId: "zacct_1",
      postId: "media_1",
      commentId: "comment_1",
      message: "check DMs",
    });

    expect(calls[0].url).toBe("https://zernio.com/api/v1/inbox/comments/media_1");
    expect(calls[0].body).toEqual({
      accountId: "zacct_1",
      commentId: "comment_1",
      message: "check DMs",
    });
  });

  it("sends a DM with a stable idempotency key", async () => {
    await zernioClient.sendDirectMessage({
      apiKey: API_KEY,
      zernioAccountId: "zacct_1",
      recipientId: "user_1",
      message: "hello",
      operationId: "op_1",
    });
    await zernioClient.sendDirectMessage({
      apiKey: API_KEY,
      zernioAccountId: "zacct_1",
      recipientId: "user_1",
      message: "hello",
      operationId: "op_1",
    });

    expect(calls[0].url).toBe("https://zernio.com/api/v1/inbox/conversations/user_1/messages");
    expect(calls[0].headers["Idempotency-Key"]).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[1].headers["Idempotency-Key"]).toBe(calls[0].headers["Idempotency-Key"]);
  });
});

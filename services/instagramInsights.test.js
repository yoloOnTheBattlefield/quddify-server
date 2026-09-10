const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Account = require("../models/Account");
const MediaInsight = require("../models/MediaInsight");
const insights = require("./instagramInsights");

let mongoServer;
let accountId;
let calls;

function mockFetch(responder) {
  calls = [];
  global.fetch = jest.fn(async (url) => {
    calls.push(String(url));
    return { json: async () => responder(String(url)) };
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await MediaInsight.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Account.deleteMany({});
  await MediaInsight.deleteMany({});
  const account = await Account.create({
    ghl: "loc_test",
    name: "Test",
    ig_oauth: { ig_user_id: "ig1", page_access_token: "tok", ig_username: "brand" },
  });
  accountId = account._id;
});

afterEach(() => jest.restoreAllMocks());

describe("metricsFor", () => {
  it("uses story-safe metrics for stories", () => {
    expect(insights.metricsFor("STORY")).toEqual(["views", "reach"]);
  });

  it("falls back to the feed list for an unknown type", () => {
    expect(insights.metricsFor("SOMETHING_NEW")).toEqual(insights.metricsFor("FEED"));
  });
});

describe("fetchAccountMedia", () => {
  it("follows pagination and drops stories", async () => {
    mockFetch((url) =>
      url.includes("after=page2")
        ? { data: [{ id: "m3", media_product_type: "FEED" }] }
        : {
            data: [
              { id: "m1", media_product_type: "REELS" },
              { id: "m2", media_product_type: "STORY" },
            ],
            paging: { next: "https://graph.facebook.com/v21.0/ig1/media?after=page2" },
          },
    );

    const media = await insights.fetchAccountMedia({ igUserId: "ig1", token: "tok" });

    expect(media.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("throws on a Graph API error", async () => {
    mockFetch(() => ({ error: { message: "Invalid OAuth token" } }));

    await expect(
      insights.fetchAccountMedia({ igUserId: "ig1", token: "bad" }),
    ).rejects.toThrow("Invalid OAuth token");
  });
});

describe("fetchMediaInsights", () => {
  it("flattens the metric rows", async () => {
    mockFetch(() => ({
      data: [
        { name: "views", values: [{ value: 1000 }] },
        { name: "shares", values: [{ value: 12 }] },
      ],
    }));

    const { metrics, error } = await insights.fetchMediaInsights({
      mediaId: "m1",
      mediaProductType: "REELS",
      token: "tok",
    });

    expect(metrics).toEqual({ views: 1000, shares: 12 });
    expect(error).toBeNull();
  });

  it("reports rather than throws when a metric is unsupported", async () => {
    mockFetch(() => ({ error: { message: "metric not supported" } }));

    const { metrics, error } = await insights.fetchMediaInsights({
      mediaId: "m1",
      mediaProductType: "FEED",
      token: "tok",
    });

    expect(metrics).toEqual({});
    expect(error).toBe("metric not supported");
  });
});

describe("syncAccountInsights", () => {
  it("upserts each post with its metrics", async () => {
    mockFetch((url) => {
      if (url.includes("/insights")) {
        return { data: [{ name: "views", values: [{ value: 5000 }] }] };
      }
      return {
        data: [
          {
            id: "m1",
            media_product_type: "REELS",
            media_type: "VIDEO",
            permalink: "https://instagram.com/p/abc",
            timestamp: "2026-09-01T00:00:00+0000",
            like_count: 42,
            comments_count: 7,
          },
        ],
      };
    });

    const result = await insights.syncAccountInsights(accountId);

    expect(result).toEqual({ synced: 1, with_insights: 1 });

    const doc = await MediaInsight.findOne({ media_id: "m1" });
    expect(doc.like_count).toBe(42);
    expect(doc.comments_count).toBe(7);
    expect(doc.views).toBe(5000);
    expect(doc.reach).toBeNull();
    expect(doc.insights_error).toBeNull();
    expect(doc.account_id.toString()).toBe(accountId.toString());
  });

  it("keeps the post when insights fail, recording why", async () => {
    mockFetch((url) =>
      url.includes("/insights")
        ? { error: { message: "no permission" } }
        : { data: [{ id: "m1", media_product_type: "FEED", like_count: 3, comments_count: 1 }] },
    );

    const result = await insights.syncAccountInsights(accountId);

    expect(result).toEqual({ synced: 1, with_insights: 0 });
    const doc = await MediaInsight.findOne({ media_id: "m1" });
    expect(doc.like_count).toBe(3);
    expect(doc.views).toBeNull();
    expect(doc.insights_error).toBe("no permission");
  });

  it("re-syncing updates in place rather than duplicating", async () => {
    let likes = 10;
    mockFetch((url) =>
      url.includes("/insights")
        ? { data: [] }
        : { data: [{ id: "m1", media_product_type: "FEED", like_count: likes, comments_count: 0 }] },
    );

    await insights.syncAccountInsights(accountId);
    likes = 25;
    await insights.syncAccountInsights(accountId);

    expect(await MediaInsight.countDocuments()).toBe(1);
    expect((await MediaInsight.findOne({ media_id: "m1" })).like_count).toBe(25);
  });

  it("refuses clearly when the account has no Meta connection", async () => {
    await Account.updateOne(
      { _id: accountId },
      { $set: { "ig_oauth.page_access_token": null, "ig_oauth.ig_user_id": null } },
    );

    const err = await insights.syncAccountInsights(accountId).catch((e) => e);

    expect(err.code).toBe("NO_META_CONNECTION");
    expect(err.message).toMatch(/Zernio does not expose post metrics/i);
  });
});

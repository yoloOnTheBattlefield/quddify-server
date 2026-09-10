const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/igOwner", () => ({ findIgOwner: jest.fn() }));
jest.mock("./telegramNotifier", () => ({
  notifyNewLead: jest.fn().mockResolvedValue(undefined),
  notifyCampaignCompleted: jest.fn(),
  notifyAiFollowUp: jest.fn(),
}));

const { findIgOwner } = require("../utils/igOwner");
const CommentRule = require("../models/CommentRule");
const CommentEvent = require("../models/CommentEvent");
const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const Account = require("../models/Account");
const commentAutomation = require("./commentAutomation");

const {
  matchKeyword,
  findMatchingRule,
  resolveTemplate,
  buildTrackedLink,
  handleCommentChange,
  processDueEvents,
} = commentAutomation;

let mongoServer;
const accountId = new mongoose.Types.ObjectId();
const IG_USER_ID = "17841400000000000";

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await CommentEvent.syncIndexes();
  await Account.create({ _id: accountId, ghl: "loc_test", name: "Test" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await CommentRule.deleteMany({});
  await CommentEvent.deleteMany({});
  await Lead.deleteMany({});
  await OutboundLead.deleteMany({});
  // processEvent now also writes a conversation, so clear it between tests
  await require("../models/IgConversation").deleteMany({});
  await require("../models/IgMessage").deleteMany({});
  jest.restoreAllMocks();
  findIgOwner.mockReset();
});

function makeRule(overrides = {}) {
  return CommentRule.create({
    account_id: accountId,
    ig_user_id: IG_USER_ID,
    name: "Guide",
    keywords: ["guide"],
    dm_text: "Hey {{firstName}}, here it is: {{link}}",
    link_url: "https://example.com/guide",
    ...overrides,
  });
}

function commentValue(overrides = {}) {
  return {
    id: "comment_1",
    text: "send me the guide please",
    from: { id: "commenter_1", username: "someone" },
    media: { id: "media_1" },
    ...overrides,
  };
}

describe("matchKeyword", () => {
  it("matches case-insensitively", () => {
    expect(matchKeyword("Send GUIDE now", ["guide"])).toBe("guide");
  });

  it("matches a substring in partial mode", () => {
    expect(matchKeyword("check my linkedin", ["link"], "partial")).toBe("link");
  });

  it("does not match a substring in whole mode", () => {
    expect(matchKeyword("check my linkedin", ["link"], "whole")).toBeNull();
  });

  it("matches a whole word next to punctuation", () => {
    expect(matchKeyword("send the link!", ["link"], "whole")).toBe("link");
  });

  it("matches a whole word next to an emoji", () => {
    expect(matchKeyword("link 🔥", ["link"], "whole")).toBe("link");
  });

  it("returns the first matching keyword", () => {
    expect(matchKeyword("i want the guide", ["nope", "guide", "want"])).toBe("guide");
  });

  it("returns null for empty text or keywords", () => {
    expect(matchKeyword("", ["guide"])).toBeNull();
    expect(matchKeyword("guide", [])).toBeNull();
  });

  it("treats regex characters as literals", () => {
    expect(matchKeyword("price is 10$", ["10$"])).toBe("10$");
    expect(matchKeyword("abc", ["a.c"])).toBeNull();
  });
});

describe("findMatchingRule", () => {
  it("skips inactive rules", () => {
    const rules = [{ active: false, keywords: ["guide"], media_ids: [] }];
    expect(findMatchingRule(rules, { text: "guide", mediaId: "m1" })).toBeNull();
  });

  it("matches any media when media_ids is empty", () => {
    const rules = [{ active: true, keywords: ["guide"], media_ids: [] }];
    expect(findMatchingRule(rules, { text: "guide", mediaId: "m9" }).keyword).toBe("guide");
  });

  it("respects media scoping", () => {
    const rules = [{ active: true, keywords: ["guide"], media_ids: ["m1"] }];
    expect(findMatchingRule(rules, { text: "guide", mediaId: "m2" })).toBeNull();
    expect(findMatchingRule(rules, { text: "guide", mediaId: "m1" }).keyword).toBe("guide");
  });
});

describe("resolveTemplate", () => {
  it("substitutes username, firstName and link", () => {
    const out = resolveTemplate("Hi {{firstName}} (@{{username}}): {{link}}", {
      username: "someone",
      fullName: "Ada Lovelace",
      link: "https://x.test",
    });
    expect(out).toBe("Hi Ada (@someone): https://x.test");
  });

  it("falls back to the username when no full name is known", () => {
    expect(resolveTemplate("Hi {{firstName}}", { username: "someone" })).toBe("Hi someone");
  });
});

describe("buildTrackedLink", () => {
  it("appends utm_medium with the lead id", () => {
    const url = new URL(buildTrackedLink("https://example.com/x", "abc123"));
    expect(url.searchParams.get("utm_medium")).toBe("abc123");
    expect(url.searchParams.get("utm_source")).toBe("comment_automation");
  });

  it("preserves existing query params", () => {
    const url = new URL(buildTrackedLink("https://example.com/x?a=1", "abc123"));
    expect(url.searchParams.get("a")).toBe("1");
  });

  it("returns an unparseable url untouched", () => {
    expect(buildTrackedLink("not a url", "abc")).toBe("not a url");
  });

  it("returns an empty string when there is no link", () => {
    expect(buildTrackedLink(null, "abc")).toBe("");
  });
});

describe("handleCommentChange", () => {
  beforeEach(() => {
    findIgOwner.mockResolvedValue({
      account_id: accountId,
      outbound_account_id: null,
      pageAccessToken: "tok",
    });
  });

  it("queues an event when a keyword matches", async () => {
    const rule = await makeRule();
    const event = await handleCommentChange(commentValue(), IG_USER_ID);

    expect(event).toBeTruthy();
    expect(event.status).toBe("queued");
    expect(event.matched_keyword).toBe("guide");
    expect(event.commenter_username).toBe("someone");

    const updated = await CommentRule.findById(rule._id);
    expect(updated.matched_count).toBe(1);
  });

  it("ignores comments that match no keyword", async () => {
    await makeRule();
    const event = await handleCommentChange(
      commentValue({ text: "nice post" }),
      IG_USER_ID,
    );
    expect(event).toBeNull();
    expect(await CommentEvent.countDocuments()).toBe(0);
  });

  it("ignores our own comments", async () => {
    await makeRule();
    const event = await handleCommentChange(
      commentValue({ from: { id: IG_USER_ID, username: "us" } }),
      IG_USER_ID,
    );
    expect(event).toBeNull();
  });

  it("is idempotent on a redelivered comment", async () => {
    await makeRule();
    const first = await handleCommentChange(commentValue(), IG_USER_ID);
    const second = await handleCommentChange(commentValue(), IG_USER_ID);

    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(await CommentEvent.countDocuments()).toBe(1);
  });

  it("ignores IG accounts we do not own", async () => {
    await makeRule();
    findIgOwner.mockResolvedValue(null);
    expect(await handleCommentChange(commentValue(), IG_USER_ID)).toBeNull();
  });

  it("ignores rules scoped to a different post", async () => {
    await makeRule({ media_ids: ["other_media"] });
    expect(await handleCommentChange(commentValue(), IG_USER_ID)).toBeNull();
  });
});

describe("processDueEvents", () => {
  beforeEach(() => {
    findIgOwner.mockResolvedValue({
      account_id: accountId,
      outbound_account_id: null,
      pageAccessToken: "tok",
    });
  });

  function mockFetch(impl) {
    global.fetch = jest.fn(impl);
    return global.fetch;
  }

  it("sends the DM, upserts the lead and marks the event sent", async () => {
    await makeRule();
    await handleCommentChange(commentValue(), IG_USER_ID);

    const calls = [];
    mockFetch(async (url, options) => {
      calls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
      if (String(url).includes("fields=permalink")) {
        return { json: async () => ({ permalink: "https://instagram.com/p/abc" }) };
      }
      return { json: async () => ({ id: "mid_1" }) };
    });

    expect(await processDueEvents()).toBe(1);

    const event = await CommentEvent.findOne({ comment_id: "comment_1" });
    expect(event.status).toBe("sent");
    expect(event.sent_at).toBeTruthy();

    const lead = await Lead.findOne({ ig_username: "someone" });
    expect(lead).toBeTruthy();
    // account_id must be the ObjectId string, never a GHL location id
    expect(lead.account_id).toBe(accountId.toString());
    expect(lead.source).toBe("comment:Guide");
    expect(lead.post_url).toBe("https://instagram.com/p/abc");
    expect(event.lead_id.toString()).toBe(lead._id.toString());

    const dmCall = calls.find((c) => String(c.url).endsWith("/messages"));
    expect(dmCall.body.recipient.comment_id).toBe("comment_1");
    expect(dmCall.body.message.text).toContain("Hey someone");
    expect(dmCall.body.message.text).toContain(`utm_medium=${lead._id}`);
  });

  it("cross-links an existing outbound lead", async () => {
    await makeRule();
    const obLead = await OutboundLead.create({
      account_id: accountId,
      username: "SomeOne",
      followingKey: "seed",
    });
    await handleCommentChange(commentValue(), IG_USER_ID);
    mockFetch(async () => ({ json: async () => ({ id: "mid_1" }) }));

    await processDueEvents();

    const lead = await Lead.findOne({ ig_username: "someone" });
    expect(lead.outbound_lead_id.toString()).toBe(obLead._id.toString());
  });

  it("retries with backoff when the send fails", async () => {
    await makeRule();
    await handleCommentChange(commentValue(), IG_USER_ID);
    mockFetch(async () => ({ json: async () => ({ error: { message: "rate limited" } }) }));

    await processDueEvents();

    const event = await CommentEvent.findOne({ comment_id: "comment_1" });
    expect(event.status).toBe("queued");
    expect(event.attempts).toBe(1);
    expect(event.error).toBe("rate limited");
    expect(event.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("marks the event failed once attempts are exhausted", async () => {
    await makeRule();
    const event = await handleCommentChange(commentValue(), IG_USER_ID);
    await CommentEvent.updateOne(
      { _id: event._id },
      { $set: { attempts: commentAutomation.MAX_ATTEMPTS - 1 } },
    );
    mockFetch(async () => ({ json: async () => ({ error: { message: "nope" } }) }));

    await processDueEvents();

    expect((await CommentEvent.findById(event._id)).status).toBe("failed");
  });

  it("skips the event when its rule has been deactivated", async () => {
    const rule = await makeRule();
    await handleCommentChange(commentValue(), IG_USER_ID);
    await CommentRule.updateOne({ _id: rule._id }, { $set: { active: false } });
    mockFetch(async () => ({ json: async () => ({ id: "mid_1" }) }));

    await processDueEvents();

    const event = await CommentEvent.findOne({ comment_id: "comment_1" });
    expect(event.status).toBe("skipped");
    expect(event.skip_reason).toBe("rule_inactive");
  });

  it("does not send when the hourly limit is already used up", async () => {
    await makeRule();
    await handleCommentChange(commentValue(), IG_USER_ID);
    await CommentEvent.create(
      Array.from({ length: commentAutomation.HOURLY_SEND_LIMIT }, (_, i) => ({
        account_id: accountId,
        ig_user_id: IG_USER_ID,
        comment_id: `filler_${i}`,
        status: "sent",
        sent_at: new Date(),
      })),
    );
    const fetchSpy = mockFetch(async () => ({ json: async () => ({ id: "mid_1" }) }));

    expect(await processDueEvents()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await CommentEvent.findOne({ comment_id: "comment_1" })).status).toBe("queued");
  });

  it("does not send an event whose backoff has not elapsed", async () => {
    await makeRule();
    const event = await handleCommentChange(commentValue(), IG_USER_ID);
    await CommentEvent.updateOne(
      { _id: event._id },
      { $set: { next_attempt_at: new Date(Date.now() + 60_000) } },
    );
    const fetchSpy = mockFetch(async () => ({ json: async () => ({ id: "mid_1" }) }));

    expect(await processDueEvents()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("recordSentDm", () => {
  const IgConversation = require("../models/IgConversation");
  const IgMessage = require("../models/IgMessage");

  beforeEach(() => {
    findIgOwner.mockResolvedValue({
      account_id: accountId,
      outbound_account_id: null,
      pageAccessToken: "tok",
      provider: "meta",
      zernio: null,
    });
  });

  afterEach(async () => {
    await IgConversation.deleteMany({});
    await IgMessage.deleteMany({});
  });

  it("writes the sent DM into the lead's conversation thread", async () => {
    await makeRule();
    await handleCommentChange(commentValue(), IG_USER_ID);
    global.fetch = jest.fn(async (url) =>
      String(url).includes("fields=permalink")
        ? { json: async () => ({ permalink: "https://instagram.com/p/abc" }) }
        : { json: async () => ({ message_id: "mid_sent_1" }) },
    );

    await processDueEvents();

    const lead = await Lead.findOne({ ig_username: "someone" });
    const conversation = await IgConversation.findOne({});

    expect(conversation).toBeTruthy();
    expect(conversation.account_id.toString()).toBe(accountId.toString());
    expect(conversation.owner_ig_user_id).toBe(IG_USER_ID);
    expect(conversation.participant_ids.sort()).toEqual([IG_USER_ID, "commenter_1"].sort());
    expect(conversation.lead_id.toString()).toBe(lead._id.toString());
    // Seeded so no Graph API lookup is needed to name the participant
    expect(conversation.participant_usernames.get("commenter_1")).toBe("someone");

    const message = await IgMessage.findOne({});
    expect(message.direction).toBe("outbound");
    expect(message.sender_id).toBe(IG_USER_ID);
    expect(message.recipient_id).toBe("commenter_1");
    expect(message.message_text).toContain("Hey someone");
    expect(message.message_id).toBe("mid_sent_1");

    // by-lead can resolve the thread through the lead too
    expect(lead.ig_thread_id).toBe(conversation.instagram_thread_id);
  });

  it("uses a deterministic message id when the provider returns none", async () => {
    await makeRule();
    await handleCommentChange(commentValue(), IG_USER_ID);
    global.fetch = jest.fn(async () => ({ json: async () => ({}) }));

    await processDueEvents();

    const message = await IgMessage.findOne({});
    expect(message.message_id).toBe("comment-automation:comment_1");
  });

  it("does not duplicate the message when the same comment is processed twice", async () => {
    await makeRule();
    const event = await handleCommentChange(commentValue(), IG_USER_ID);
    global.fetch = jest.fn(async () => ({ json: async () => ({}) }));

    await processDueEvents();
    // Force a second pass over the same event
    await CommentEvent.updateOne(
      { _id: event._id },
      { $set: { status: "queued", next_attempt_at: new Date() } },
    );
    await processDueEvents();

    expect(await IgMessage.countDocuments()).toBe(1);
    expect(await IgConversation.countDocuments()).toBe(1);
  });

  it("skips recording when the commenter's IG id is unknown", async () => {
    await makeRule();
    await handleCommentChange(
      commentValue({ from: { username: "someone" } }),
      IG_USER_ID,
    );
    global.fetch = jest.fn(async () => ({ json: async () => ({}) }));

    await processDueEvents();

    expect(await IgConversation.countDocuments()).toBe(0);
  });

  it("stamps link_sent_at only when the rule carries a link", async () => {
    await makeRule({ link_url: null, dm_text: "no link here" });
    await handleCommentChange(commentValue(), IG_USER_ID);
    global.fetch = jest.fn(async () => ({ json: async () => ({}) }));

    await processDueEvents();

    expect((await Lead.findOne({ ig_username: "someone" })).link_sent_at).toBeNull();
  });

  it("stamps link_sent_at when a link was delivered", async () => {
    await makeRule();
    await handleCommentChange(commentValue(), IG_USER_ID);
    global.fetch = jest.fn(async () => ({ json: async () => ({}) }));

    await processDueEvents();

    expect((await Lead.findOne({ ig_username: "someone" })).link_sent_at).toBeTruthy();
  });
});

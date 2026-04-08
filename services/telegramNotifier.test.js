const {
  notifyNewLead,
  notifyCampaignCompleted,
  notifyAiFollowUp,
} = require("./telegramNotifier");

// Mock crypto
jest.mock("../utils/crypto", () => ({
  decrypt: jest.fn((val) => val === "encrypted_token" ? "123:ABCDEF" : val),
  encrypt: jest.fn((val) => `enc:${val}`),
}));

// Mock models
jest.mock("../models/CampaignLead", () => ({
  findOne: jest.fn(() => ({ sort: jest.fn(() => ({ lean: jest.fn(() => null) })) })),
}));
jest.mock("../models/SenderAccount", () => ({
  findById: jest.fn(() => ({ lean: jest.fn(() => null) })),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

afterEach(() => {
  mockFetch.mockReset();
});

describe("notifyNewLead", () => {
  const account = {
    telegram_bot_token: "encrypted_token",
    telegram_chat_id: "-100123",
  };

  const lead = {
    first_name: "John",
    last_name: "Doe",
    email: "john@example.com",
    ig_username: "johndoe",
    source: "calendly",
  };

  it("sends a Telegram message for a new lead", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await notifyNewLead(account, lead, null);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("api.telegram.org/bot123:ABCDEF/sendMessage");
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe("-100123");
    expect(body.text).toContain("New Inbound Lead");
    expect(body.text).toContain("John Doe");
    expect(body.text).toContain("johndoe");
  });

  it("includes outbound lead info when linked", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const outbound = {
      _id: "ob1",
      username: "prospect_ig",
      source: "deep_scrape",
      promptLabel: "Fitness Intro",
    };

    await notifyNewLead(account, lead, outbound);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toContain("Linked to Outbound Lead");
    expect(body.text).toContain("prospect\\_ig");
    expect(body.text).toContain("deep\\_scrape");
    expect(body.text).toContain("Fitness Intro");
  });

  it("does nothing when no telegram config", async () => {
    await notifyNewLead({ telegram_bot_token: null, telegram_chat_id: null }, lead, null);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles Telegram API errors gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ description: "Forbidden" }),
    });

    // Should not throw
    await notifyNewLead(account, lead, null);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("notifyCampaignCompleted", () => {
  const account = {
    telegram_bot_token: "encrypted_token",
    telegram_chat_id: "-100123",
  };

  const campaign = { name: "Summer Outreach" };

  const stats = { sent: 50, delivered: 45, replied: 10, failed: 3, skipped: 2 };

  it("sends a notification with campaign name and stats", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await notifyCampaignCompleted(account, campaign, stats);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("api.telegram.org/bot123:ABCDEF/sendMessage");
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe("-100123");
    expect(body.text).toContain("Campaign Completed");
    expect(body.text).toContain("Summer Outreach");
    expect(body.text).toContain("No more leads to send");
    expect(body.text).toContain("50");
    expect(body.text).toContain("10");
  });

  it("sends notification without stats when stats is null", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await notifyCampaignCompleted(account, campaign, null);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toContain("Campaign Completed");
    expect(body.text).not.toContain("Stats");
  });

  it("does nothing when no telegram config", async () => {
    await notifyCampaignCompleted({ telegram_bot_token: null, telegram_chat_id: null }, campaign, stats);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("notifyAiFollowUp", () => {
  const account = {
    telegram_bot_token: "encrypted_token",
    telegram_chat_id: "-100123",
  };

  const lead = {
    username: "prospect_ig",
    fullName: "Jane Prospect",
    profileLink: "https://instagram.com/prospect_ig",
  };

  it("sends a 'new follow-up' notification with lead details", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await notifyAiFollowUp(account, {
      lead,
      status: "need_reply",
      reason: "new",
      outboundAccount: { username: "sender_acct" },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("api.telegram.org/bot123:ABCDEF/sendMessage");
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe("-100123");
    expect(body.text).toContain("AI created a new Follow-Up");
    expect(body.text).toContain("prospect\\_ig");
    expect(body.text).toContain("Jane Prospect");
    expect(body.text).toContain("need\\_reply");
    expect(body.text).toContain("sender\\_acct");
  });

  it("sends a 'follow_up_later' transition notification", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await notifyAiFollowUp(account, {
      lead,
      status: "follow_up_later",
      reason: "follow_up_later",
      outboundAccount: null,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toContain("AI moved lead to Follow-Up Later");
    expect(body.text).toContain("prospect\\_ig");
    expect(body.text).toContain("follow\\_up\\_later");
  });

  it("does nothing when no telegram config", async () => {
    await notifyAiFollowUp(
      { telegram_bot_token: null, telegram_chat_id: null },
      { lead, status: "need_reply", reason: "new" },
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles Telegram API errors gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ description: "Forbidden" }),
    });

    await notifyAiFollowUp(account, { lead, status: "need_reply", reason: "new" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

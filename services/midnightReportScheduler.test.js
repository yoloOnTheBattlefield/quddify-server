const { sendReportForAccount } = require("./midnightReportScheduler");

// Mock fetch globally
global.fetch = jest.fn();

jest.mock("../utils/logger", () => {
  const noop = () => {};
  const child = () => ({ info: noop, error: noop, warn: noop, debug: noop });
  return { child, info: noop, error: noop, warn: noop, debug: noop };
});

jest.mock("../utils/crypto", () => ({
  decrypt: jest.fn(() => "fake-bot-token"),
}));

function makeCampaignFind(campaignIds = ["camp1"]) {
  return {
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(campaignIds.map((id) => ({ _id: id }))),
      }),
    }),
  };
}

function makeModels(overrides = {}) {
  const defaults = {
    Campaign: makeCampaignFind(),
    CampaignLead: { countDocuments: jest.fn().mockResolvedValue(0) },
    OutboundLead: { countDocuments: jest.fn().mockResolvedValue(0) },
    Lead: { countDocuments: jest.fn().mockResolvedValue(0) },
    Booking: {
      countDocuments: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue([]),
    },
  };
  return { ...defaults, ...overrides };
}

const fakeAccount = {
  _id: "acc1",
  telegram_bot_token: "encrypted-token",
  telegram_chat_id: "12345",
};

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch.mockResolvedValue({ ok: true });
});

describe("sendReportForAccount", () => {
  it("sends a Telegram message with stats", async () => {
    const models = makeModels({
      CampaignLead: { countDocuments: jest.fn().mockResolvedValue(42) },
      OutboundLead: { countDocuments: jest.fn().mockResolvedValue(5) },
    });

    await sendReportForAccount(fakeAccount, models);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain("api.telegram.org/botfake-bot-token/sendMessage");
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe("12345");
    expect(body.text).toContain("Daily Report");
    expect(body.text).toContain("DMs Sent: *42*");
    expect(body.text).toContain("Replies: *5*");
  });

  it("includes revenue when present", async () => {
    const models = makeModels({
      Booking: {
        countDocuments: jest.fn().mockResolvedValue(2),
        aggregate: jest.fn().mockResolvedValue([{ _id: null, total: 3500 }]),
      },
    });

    await sendReportForAccount(fakeAccount, models);

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toContain("$3,500");
    expect(body.text).toContain("Total Bookings:* 2");
  });

  it("skips sending when bot token cannot be decrypted", async () => {
    const { decrypt } = require("../utils/crypto");
    decrypt.mockImplementationOnce(() => {
      throw new Error("bad key");
    });

    await sendReportForAccount(fakeAccount, makeModels());

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

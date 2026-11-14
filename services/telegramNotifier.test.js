const {
  notifyNewLead,
} = require("./telegramNotifier");

// Mock crypto
jest.mock("../utils/crypto", () => ({
  decrypt: jest.fn((val) => val === "encrypted_token" ? "123:ABCDEF" : val),
  encrypt: jest.fn((val) => `enc:${val}`),
}));

// Mock models

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

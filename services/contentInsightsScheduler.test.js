jest.mock("../utils/logger", () => {
  const noop = () => {};
  const logger = { info: noop, error: noop, warn: noop, debug: noop, child: () => logger };
  return logger;
});

const mockFind = jest.fn();
jest.mock("../models/Account", () => ({ find: (...a) => mockFind(...a) }));

const mockSync = jest.fn();
jest.mock("./instagramInsights", () => ({ syncAccountInsights: (...a) => mockSync(...a) }));

const scheduler = require("./contentInsightsScheduler");

function accounts(list) {
  mockFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(list) }) });
}

beforeEach(() => {
  mockFind.mockReset();
  mockSync.mockReset();
});

describe("contentInsightsScheduler.syncAll", () => {
  it("syncs every Meta-connected account and survives one failing", async () => {
    accounts([{ _id: "a1" }, { _id: "a2" }]);
    mockSync
      .mockRejectedValueOnce(new Error("token expired"))
      .mockResolvedValueOnce({ synced: 4, with_insights: 4 });

    const result = await scheduler.syncAll();

    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(mockSync).toHaveBeenCalledWith("a1", { days: 90 });
    expect(result).toEqual({ accounts: 2, synced: 1, failed: 1 });
  });

  it("only asks for accounts with a page token", async () => {
    accounts([]);
    await scheduler.syncAll();
    expect(mockFind.mock.calls[0][0]).toMatchObject({
      "ig_oauth.page_access_token": { $ne: null },
    });
  });

  it("start/stop does not throw", () => {
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });
});

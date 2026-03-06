const { computeDailyLimit } = require("./computeDailyLimit");

describe("computeDailyLimit", () => {
  it("returns 50 when outbound is null/undefined", () => {
    expect(computeDailyLimit(null)).toBe(50);
    expect(computeDailyLimit(undefined)).toBe(50);
  });

  it("returns 0 for 'new' status", () => {
    expect(computeDailyLimit({ status: "new" })).toBe(0);
  });

  it("returns 0 for 'restricted' status", () => {
    expect(computeDailyLimit({ status: "restricted" })).toBe(0);
  });

  it("returns 0 for 'disabled' status", () => {
    expect(computeDailyLimit({ status: "disabled" })).toBe(0);
  });

  it("returns 50 for 'ready' status", () => {
    expect(computeDailyLimit({ status: "ready" })).toBe(50);
  });

  it("returns 0 for unknown status", () => {
    expect(computeDailyLimit({ status: "something_else" })).toBe(0);
  });

  describe("warming status", () => {
    it("returns 0 when warmup is not enabled", () => {
      expect(computeDailyLimit({ status: "warming", warmup: { enabled: false } })).toBe(0);
    });

    it("returns 0 when warmup has no startDate", () => {
      expect(computeDailyLimit({ status: "warming", warmup: { enabled: true } })).toBe(0);
    });

    it("returns cap from matching warmup day", () => {
      const now = new Date();
      const startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0); // today at midnight = day 1

      const outbound = {
        status: "warming",
        warmup: {
          enabled: true,
          startDate: startDate.toISOString(),
          schedule: [
            { day: 1, cap: 5 },
            { day: 2, cap: 10 },
            { day: 3, cap: 15 },
          ],
        },
      };

      expect(computeDailyLimit(outbound)).toBe(5);
    });

    it("returns 0 when no schedule entry matches current day", () => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 10); // 11 days ago = day 11

      const outbound = {
        status: "warming",
        warmup: {
          enabled: true,
          startDate: startDate.toISOString(),
          schedule: [
            { day: 1, cap: 5 },
            { day: 2, cap: 10 },
          ],
        },
      };

      expect(computeDailyLimit(outbound)).toBe(0);
    });

    it("returns 0 when schedule is empty", () => {
      const outbound = {
        status: "warming",
        warmup: {
          enabled: true,
          startDate: new Date().toISOString(),
          schedule: [],
        },
      };

      expect(computeDailyLimit(outbound)).toBe(0);
    });
  });
});

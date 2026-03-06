const {
  resolveTemplate,
  isWithinActiveHours,
  getEffectiveDailyLimit,
  isAccountResting,
} = require("./campaignScheduler");

describe("resolveTemplate", () => {
  it("replaces {{username}}", () => {
    expect(resolveTemplate("Hey {{username}}!", { username: "john" })).toBe("Hey john!");
  });

  it("replaces {{firstName}} from fullName", () => {
    expect(resolveTemplate("Hi {{firstName}}", { fullName: "John Doe" })).toBe("Hi John");
  });

  it("replaces {{name}} with fullName", () => {
    expect(resolveTemplate("Hello {{name}}", { fullName: "Jane Smith" })).toBe("Hello Jane Smith");
  });

  it("replaces {{bio}}", () => {
    expect(resolveTemplate("Bio: {{bio}}", { bio: "I love coding" })).toBe("Bio: I love coding");
  });

  it("falls back to empty strings for missing fields", () => {
    expect(resolveTemplate("Hey {{username}} {{bio}}", {})).toBe("Hey  ");
  });

  it("uses username as firstName fallback when no fullName", () => {
    expect(resolveTemplate("Hi {{firstName}}", { username: "maria" })).toBe("Hi maria");
  });

  it("replaces multiple occurrences", () => {
    expect(
      resolveTemplate("{{username}} is {{username}}", { username: "test" }),
    ).toBe("test is test");
  });
});

describe("isWithinActiveHours", () => {
  it("returns true when current hour is within active range", () => {
    const schedule = {
      timezone: "UTC",
      active_hours_start: 0,
      active_hours_end: 24,
    };
    expect(isWithinActiveHours(schedule)).toBe(true);
  });

  it("returns false when active range is impossible (start >= end)", () => {
    const schedule = {
      timezone: "UTC",
      active_hours_start: 23,
      active_hours_end: 23,
    };
    expect(isWithinActiveHours(schedule)).toBe(false);
  });

  it("defaults to America/New_York timezone", () => {
    const schedule = { active_hours_start: 0, active_hours_end: 24 };
    expect(isWithinActiveHours(schedule)).toBe(true);
  });
});

describe("getEffectiveDailyLimit", () => {
  it("returns base limit when no warmup configured", () => {
    expect(getEffectiveDailyLimit({ daily_limit_per_sender: 50 })).toBe(50);
  });

  it("defaults to 50 when daily_limit_per_sender not set", () => {
    expect(getEffectiveDailyLimit({})).toBe(50);
  });

  it("returns base limit when warmup_days is 0", () => {
    expect(
      getEffectiveDailyLimit({
        daily_limit_per_sender: 40,
        warmup_days: 0,
      }),
    ).toBe(40);
  });

  it("returns base limit when no warmup_start_date", () => {
    expect(
      getEffectiveDailyLimit({
        daily_limit_per_sender: 30,
        warmup_days: 7,
      }),
    ).toBe(30);
  });

  it("ramps up limit during warmup period", () => {
    const campaign = {
      daily_limit_per_sender: 50,
      warmup_days: 10,
      warmup_start_date: new Date(), // day 1
    };

    const limit = getEffectiveDailyLimit(campaign);
    // Day 1: ceil(50 * 1 / 10) = 5
    expect(limit).toBe(5);
  });

  it("returns base limit after warmup period ends", () => {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 20); // 20 days ago, warmup_days is 10

    const campaign = {
      daily_limit_per_sender: 50,
      warmup_days: 10,
      warmup_start_date: startDate,
    };

    expect(getEffectiveDailyLimit(campaign)).toBe(50);
  });

  it("always returns at least 1 during warmup", () => {
    const campaign = {
      daily_limit_per_sender: 1,
      warmup_days: 100,
      warmup_start_date: new Date(), // day 1
    };

    expect(getEffectiveDailyLimit(campaign)).toBeGreaterThanOrEqual(1);
  });
});

describe("isAccountResting", () => {
  it("returns false when no streak_rest_until", () => {
    expect(isAccountResting({})).toBe(false);
    expect(isAccountResting({ streak_rest_until: null })).toBe(false);
  });

  it("returns true when rest date is in the future", () => {
    const future = new Date();
    future.setDate(future.getDate() + 2);
    expect(isAccountResting({ streak_rest_until: future })).toBe(true);
  });

  it("returns false when rest date is in the past", () => {
    const past = new Date();
    past.setDate(past.getDate() - 2);
    expect(isAccountResting({ streak_rest_until: past })).toBe(false);
  });
});

const { toNumber, toDate, toBoolean } = require("./normalize");

describe("toNumber", () => {
  it("converts numeric strings", () => {
    expect(toNumber("42")).toBe(42);
    expect(toNumber("3.14")).toBe(3.14);
  });

  it("strips commas from formatted numbers", () => {
    expect(toNumber("1,000")).toBe(1000);
    expect(toNumber("1,234,567")).toBe(1234567);
  });

  it("trims whitespace", () => {
    expect(toNumber("  99  ")).toBe(99);
  });

  it("returns null for empty/null/undefined", () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber("")).toBeNull();
  });

  it("returns null for non-numeric strings", () => {
    expect(toNumber("abc")).toBeNull();
    expect(toNumber("not a number")).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(toNumber("Infinity")).toBeNull();
  });

  it("passes through actual numbers", () => {
    expect(toNumber(7)).toBe(7);
  });
});

describe("toDate", () => {
  it("parses valid date strings", () => {
    const d = toDate("2025-01-15");
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2025);
  });

  it("parses ISO strings", () => {
    const d = toDate("2025-06-01T12:00:00.000Z");
    expect(d).toBeInstanceOf(Date);
  });

  it("returns null for falsy values", () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("")).toBeNull();
    expect(toDate(0)).toBeNull();
  });

  it("returns null for invalid date strings", () => {
    expect(toDate("not-a-date")).toBeNull();
  });
});

describe("toBoolean", () => {
  it("returns true for truthy string values", () => {
    expect(toBoolean("yes")).toBe(true);
    expect(toBoolean("true")).toBe(true);
    expect(toBoolean("y")).toBe(true);
    expect(toBoolean("1")).toBe(true);
    expect(toBoolean("YES")).toBe(true);
    expect(toBoolean("True")).toBe(true);
  });

  it("returns false for falsy string values", () => {
    expect(toBoolean("no")).toBe(false);
    expect(toBoolean("false")).toBe(false);
    expect(toBoolean("n")).toBe(false);
    expect(toBoolean("0")).toBe(false);
    expect(toBoolean("NO")).toBe(false);
  });

  it("passes through actual booleans", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(false)).toBe(false);
  });

  it("returns null for null/undefined", () => {
    expect(toBoolean(null)).toBeNull();
    expect(toBoolean(undefined)).toBeNull();
  });

  it("returns null for unrecognized strings", () => {
    expect(toBoolean("maybe")).toBeNull();
    expect(toBoolean("dunno")).toBeNull();
  });

  it("trims whitespace and is case-insensitive", () => {
    expect(toBoolean("  Yes  ")).toBe(true);
    expect(toBoolean(" FALSE ")).toBe(false);
  });
});

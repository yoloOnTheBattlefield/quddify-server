const escapeRegex = require("./escapeRegex");

describe("escapeRegex", () => {
  it("returns plain strings unchanged", () => {
    expect(escapeRegex("hello")).toBe("hello");
  });

  it("escapes dots", () => {
    expect(escapeRegex("a.b")).toBe("a\\.b");
  });

  it("escapes all special regex characters", () => {
    const input = ".*+?^${}()|[]\\";
    const result = escapeRegex(input);
    // every special char should be escaped
    expect(result).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
  });

  it("handles empty string", () => {
    expect(escapeRegex("")).toBe("");
  });

  it("prevents ReDoS-style patterns", () => {
    const malicious = "(a+)+$";
    const escaped = escapeRegex(malicious);
    expect(escaped).toBe("\\(a\\+\\)\\+\\$");
    // The escaped version should be safe to use in a regex
    const re = new RegExp(escaped);
    expect(re.test("(a+)+$")).toBe(true);
    expect(re.test("aaa")).toBe(false);
  });
});

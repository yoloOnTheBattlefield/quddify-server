const { applyColumnMapping, DEFAULT_COLUMN_MAPPING } = require("./columnMapping");

describe("applyColumnMapping", () => {
  it("maps headers to internal fields", () => {
    const row = { Username: "@john_doe", "Full name": "John Doe" };
    const mapping = { Username: "username", "Full name": "fullName" };

    const result = applyColumnMapping(row, mapping);
    expect(result.username).toBe("john_doe"); // strips @ and lowercases
    expect(result.fullName).toBe("John Doe");
  });

  it("skips null mappings (ignored columns)", () => {
    const row = { Username: "testuser", "Random Col": "something" };
    const mapping = { Username: "username", "Random Col": null };

    const result = applyColumnMapping(row, mapping);
    expect(result.username).toBe("testuser");
    expect(result).not.toHaveProperty("Random Col");
  });

  it("returns null for empty/null/undefined values", () => {
    const row = { Username: "", "Full name": null, Source: undefined };
    const mapping = { Username: "username", "Full name": "fullName", Source: "source" };

    const result = applyColumnMapping(row, mapping);
    expect(result.username).toBeNull();
    expect(result.fullName).toBeNull();
    expect(result.source).toBeNull();
  });

  it("converts numeric fields with toNumber", () => {
    const row = { Followers: "1,234", Posts: "56" };
    const mapping = { Followers: "followersCount", Posts: "postsCount" };

    const result = applyColumnMapping(row, mapping);
    expect(result.followersCount).toBe(1234);
    expect(result.postsCount).toBe(56);
  });

  it("converts boolean fields with toBoolean", () => {
    const row = { Verified: "yes", Messaged: "no" };
    const mapping = { Verified: "isVerified", Messaged: "isMessaged" };

    const result = applyColumnMapping(row, mapping);
    expect(result.isVerified).toBe(true);
    expect(result.isMessaged).toBe(false);
  });

  it("converts date fields with toDate", () => {
    const row = { "DM Date": "2025-06-01", "Scrape Date": "2025-05-15" };
    const mapping = { "DM Date": "dmDate", "Scrape Date": "scrapeDate" };

    const result = applyColumnMapping(row, mapping);
    expect(result.dmDate).toBeInstanceOf(Date);
    expect(result.scrapeDate).toBeInstanceOf(Date);
  });

  it("normalizes username: strips leading @, trims, lowercases", () => {
    const row = { User: "@JohnDoe" };
    const mapping = { User: "username" };

    const result = applyColumnMapping(row, mapping);
    expect(result.username).toBe("johndoe");
  });

  it("handles username with spaces (trim + lowercase but @ only stripped if leading)", () => {
    const row = { User: "  JohnDoe  " };
    const mapping = { User: "username" };

    const result = applyColumnMapping(row, mapping);
    expect(result.username).toBe("johndoe");
  });

  it("strips leading @ from username even with leading spaces", () => {
    const row = { User: " @MoorGs " };
    const mapping = { User: "username" };

    const result = applyColumnMapping(row, mapping);
    expect(result.username).toBe("moorgs");
  });

  it("strips leading @ from ig field and lowercases", () => {
    const row = { IG: "@TestHandle" };
    const mapping = { IG: "ig" };

    const result = applyColumnMapping(row, mapping);
    expect(result.ig).toBe("testhandle");
  });

  it("trims string fields and returns null for empty after trim", () => {
    const row = { Source: "  Instagram  ", Bio: "   " };
    const mapping = { Source: "source", Bio: "bio" };

    const result = applyColumnMapping(row, mapping);
    expect(result.source).toBe("Instagram");
    expect(result.bio).toBeNull();
  });
});

describe("DEFAULT_COLUMN_MAPPING", () => {
  it("maps Username to username", () => {
    expect(DEFAULT_COLUMN_MAPPING.Username).toBe("username");
  });

  it("maps common columns correctly", () => {
    expect(DEFAULT_COLUMN_MAPPING["Full name"]).toBe("fullName");
    expect(DEFAULT_COLUMN_MAPPING["Followers count"]).toBe("followersCount");
    expect(DEFAULT_COLUMN_MAPPING["Is verified"]).toBe("isVerified");
    expect(DEFAULT_COLUMN_MAPPING.Biography).toBe("bio");
    expect(DEFAULT_COLUMN_MAPPING.Email).toBe("email");
  });
});

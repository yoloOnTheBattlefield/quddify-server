const XLSX = require("xlsx");

// Extract the regex and parseFilename by re-declaring them (they're not exported)
const FILENAME_REGEX =
  /^(?:follower|following)-of-([A-Za-z0-9._-]+)-(\d{8})\.(xlsx|csv)$/;

function parseFilename(filename) {
  const match = filename.match(FILENAME_REGEX);
  if (!match) {
    throw new Error(
      `Invalid filename format: ${filename}. Expected: follower-of-{account}-{YYYYMMDD}.xlsx/.csv or following-of-{account}-{YYYYMMDD}.xlsx/.csv`,
    );
  }
  const sourceAccount = match[1];
  const rawDate = match[2];
  const scrapeDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
  return { sourceAccount, scrapeDate };
}

function parseXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
  if (rows.length > 0) rows.pop();
  return rows;
}

describe("FILENAME_REGEX", () => {
  it("matches .xlsx filenames", () => {
    expect(FILENAME_REGEX.test("follower-of-johndoe-20260401.xlsx")).toBe(true);
    expect(FILENAME_REGEX.test("following-of-jane_doe-20260315.xlsx")).toBe(true);
  });

  it("matches .csv filenames", () => {
    expect(FILENAME_REGEX.test("follower-of-johndoe-20260401.csv")).toBe(true);
    expect(FILENAME_REGEX.test("following-of-jane_doe-20260315.csv")).toBe(true);
  });

  it("rejects other extensions", () => {
    expect(FILENAME_REGEX.test("follower-of-johndoe-20260401.pdf")).toBe(false);
    expect(FILENAME_REGEX.test("follower-of-johndoe-20260401.xls")).toBe(false);
    expect(FILENAME_REGEX.test("follower-of-johndoe-20260401.json")).toBe(false);
  });

  it("rejects malformed filenames", () => {
    expect(FILENAME_REGEX.test("random-file.xlsx")).toBe(false);
    expect(FILENAME_REGEX.test("follower-of-20260401.csv")).toBe(false);
    expect(FILENAME_REGEX.test("follower-of-account.csv")).toBe(false);
  });
});

describe("parseFilename", () => {
  it("parses .xlsx filename correctly", () => {
    const result = parseFilename("follower-of-testaccount-20260401.xlsx");
    expect(result.sourceAccount).toBe("testaccount");
    expect(result.scrapeDate).toBe("2026-04-01");
  });

  it("parses .csv filename correctly", () => {
    const result = parseFilename("follower-of-testaccount-20260401.csv");
    expect(result.sourceAccount).toBe("testaccount");
    expect(result.scrapeDate).toBe("2026-04-01");
  });

  it("parses following-of pattern", () => {
    const result = parseFilename("following-of-user.name-20260315.csv");
    expect(result.sourceAccount).toBe("user.name");
    expect(result.scrapeDate).toBe("2026-03-15");
  });

  it("throws on invalid filename", () => {
    expect(() => parseFilename("bad-file.csv")).toThrow(/Invalid filename format/);
  });
});

describe("parseXlsx — CSV buffer support", () => {
  it("parses a CSV buffer via SheetJS", () => {
    const csvContent = "Username,Email,Bio\nalice,alice@test.com,Coach\nbob,bob@test.com,Consultant\ncarol,carol@test.com,Trainer\n";
    const buffer = Buffer.from(csvContent, "utf-8");
    const rows = parseXlsx(buffer);

    // Last row removed (scraper notice logic)
    expect(rows).toHaveLength(2);
    expect(rows[0].Username).toBe("alice");
    expect(rows[0].Email).toBe("alice@test.com");
    expect(rows[1].Username).toBe("bob");
  });

  it("parses an XLSX buffer via SheetJS", () => {
    // Build a real XLSX buffer using SheetJS
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([
      { Username: "alice", Email: "alice@test.com" },
      { Username: "bob", Email: "bob@test.com" },
      { Username: "carol", Email: "carol@test.com" },
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const rows = parseXlsx(buffer);

    expect(rows).toHaveLength(2);
    expect(rows[0].Username).toBe("alice");
  });

  it("returns empty array for empty CSV", () => {
    const buffer = Buffer.from("", "utf-8");
    const rows = parseXlsx(buffer);
    expect(rows).toEqual([]);
  });
});

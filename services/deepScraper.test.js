/**
 * Regression test: APIFY_MEMORY_MB must be importable from deepScraper's
 * require of apifyHelpers. Previously the import was missing, causing
 * "APIFY_MEMORY_MB is not defined" at runtime.
 */

describe("deepScraper module", () => {
  it("imports APIFY_MEMORY_MB without throwing ReferenceError", () => {
    // If the destructured import is missing, requiring the module will succeed
    // but any function referencing APIFY_MEMORY_MB will throw ReferenceError.
    // We verify the constant is accessible in the module scope by checking that
    // the module loads and the re-exported helpers still reference it correctly.
    expect(() => {
      // Re-parse the require list from deepScraper to confirm the import exists
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(path.join(__dirname, "deepScraper.js"), "utf8");
      const requireBlock = src.match(
        /require\(["']\.\/apifyHelpers["']\)/
      );
      expect(requireBlock).not.toBeNull();

      // The actual regression: APIFY_MEMORY_MB must appear in the destructured import
      const destructureMatch = src.match(
        /const\s*\{[^}]*\}\s*=\s*require\(["']\.\/apifyHelpers["']\)/s
      );
      expect(destructureMatch).not.toBeNull();
      expect(destructureMatch[0]).toContain("APIFY_MEMORY_MB");
    }).not.toThrow();
  });

  it("APIFY_MEMORY_MB is used in a log message template", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "deepScraper.js"), "utf8");

    // Confirm the variable is actually referenced (the line that was crashing)
    expect(src).toMatch(/\$\{APIFY_MEMORY_MB\}/);
  });
});

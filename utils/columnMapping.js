const { toNumber, toDate, toBoolean } = require("./normalize");

/**
 * Given a raw XLSX row and a columnMapping object,
 * returns a normalized lead data object with internal field names.
 *
 * @param {Object} row - Raw row from parseXlsx (keys are spreadsheet headers)
 * @param {Object} mapping - { spreadsheetHeader: internalField | null }
 * @returns {Object} Normalized lead object with internal field names
 */
function applyColumnMapping(row, mapping) {
  const result = {};

  for (const [header, field] of Object.entries(mapping)) {
    if (!field) continue;
    const rawValue = row[header];
    if (rawValue === undefined || rawValue === null || rawValue === "") {
      result[field] = null;
      continue;
    }

    switch (field) {
      case "followersCount":
      case "postsCount":
        result[field] = toNumber(rawValue);
        break;
      case "isVerified":
      case "isMessaged":
        result[field] = toBoolean(rawValue);
        break;
      case "dmDate":
      case "scrapeDate":
        result[field] = toDate(rawValue);
        break;
      case "username":
        result[field] = String(rawValue).replace(/^@/, "").trim().toLowerCase();
        break;
      default:
        result[field] = String(rawValue).trim() || null;
        break;
    }
  }

  return result;
}

/**
 * Default mapping matching the current hardcoded column names.
 * Used as fallback when no custom mapping is provided.
 */
const DEFAULT_COLUMN_MAPPING = {
  "Username": "username",
  "Full name": "fullName",
  "Profile link": "profileLink",
  "Is verified": "isVerified",
  "Followers count": "followersCount",
  "Biography": "bio",
  "Posts count": "postsCount",
  "External url": "externalUrl",
  "Public email": "email",
  "Email": "email",
  "Source": "source",
  "Scrape Date": "scrapeDate",
  "IG": "ig",
  "Messaged?": "isMessaged",
  "DM Date": "dmDate",
  "Message": "message",
};

module.exports = { applyColumnMapping, DEFAULT_COLUMN_MAPPING };

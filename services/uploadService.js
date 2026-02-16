const XLSX = require("xlsx");
const OpenAI = require("openai");
const OutboundLead = require("../models/OutboundLead");
const IgAccount = require("../models/IgAccount");
const Prompt = require("../models/Prompt");
const { toNumber, toDate, toBoolean } = require("../utils/normalize");

const openai = new OpenAI({ apiKey: process.env.OPENAI });

const FILENAME_REGEX =
  /^(?:follower|following)-of-([A-Za-z0-9._-]+)-(\d{8})\.xlsx$/;

const DEFAULT_QUALIFICATION_PROMPT = `You are an assistant tasked with classifying Instagram bios as either Qualified or Unqualified based on whether the person is likely a coach, consultant, or sells services that relate to personal/business transformation.

For a bio to be Qualified, it must clearly show intent to help others, either via coaching, consulting, mentoring, or services like branding, scaling, teaching, strategy, or content-based growth.

Look for indicators such as:

Service-based keywords: coach, consultant, mentor, trainer, strategist, advisor

Help-indicating language: "I help…", "DM for…", "Work with me…", "Join my program…"

Transformation themes: "build your brand", "scale your business", "fitness coaching", "turn your story into…", "get clients", etc.

B2B/B2C transformation handles or agencies

Personal development or financial growth + offer to guide/support

Return \`Qualified\` if the bio clearly or strongly implies they help others for money. Otherwise, return \`Unqualified\`.`;

async function qualifyBio(bio, promptText, openaiClient) {
  if (!bio || bio.trim() === "") return "Unqualified";

  const client = openaiClient || openai;
  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: promptText },
      { role: "user", content: bio },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim();
  return content === "Qualified" ? "Qualified" : "Unqualified";
}

function parseFilename(filename) {
  const match = filename.match(FILENAME_REGEX);
  if (!match) {
    throw new Error(
      `Invalid filename format: ${filename}. Expected: follower-of-{account}-{YYYYMMDD}.xlsx or following-of-{account}-{YYYYMMDD}.xlsx`,
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

  // Remove last row (upgrade to premium notice)
  if (rows.length > 0) rows.pop();

  return rows;
}

async function processUpload(fileBuffer, filename, promptId, accountId) {
  // 1. Extract metadata from filename
  const { sourceAccount, scrapeDate } = parseFilename(filename);

  // 2. Resolve qualification prompt
  let promptDoc = null;
  let promptText = DEFAULT_QUALIFICATION_PROMPT;

  if (promptId) {
    promptDoc = await Prompt.findById(promptId).lean();
    if (!promptDoc) {
      throw new Error(`Prompt not found: ${promptId}`);
    }
    promptText = promptDoc.promptText;
  }

  // 2. Parse XLSX
  const rows = parseXlsx(fileBuffer);
  const totalRowsParsed = rows.length;

  // 3. Get existing usernames globally to prevent duplicates
  const rowUsernames = rows.map((r) => String(r["Username"] || "").trim()).filter(Boolean);
  const existingOutboundLeads = await OutboundLead.find(
    { username: { $in: rowUsernames } },
    { username: 1 },
  ).lean();
  const existingUsernames = new Set(existingOutboundLeads.map((f) => f.username));

  // 4. Filter rows using prompt filters (or defaults)
  const f = promptDoc?.filters || {};
  const minFollowers = f.minFollowers ?? 40000;
  const minPosts = f.minPosts ?? 10;
  const excludePrivate = f.excludePrivate ?? true;
  const verifiedOnly = f.verifiedOnly ?? false;
  const bioRequired = f.bioRequired ?? false;

  const filtered = rows.filter((row) => {
    const followers = toNumber(row["Followers count"]);
    const posts = toNumber(row["Posts count"]);
    const isPrivate = String(row["Is private"] || "")
      .trim()
      .toUpperCase();
    const isVerified = String(row["Is verified"] || "")
      .trim()
      .toUpperCase();
    const username = String(row["Username"] || "").trim();
    const bio = (row["Biography"] || "").trim();

    if (!username || existingUsernames.has(username)) return false;
    if (followers === null || followers < minFollowers) return false;
    if (posts === null || posts <= minPosts) return false;
    if (excludePrivate && isPrivate !== "NO") return false;
    if (verifiedOnly && isVerified !== "YES") return false;
    if (bioRequired && !bio) return false;

    return true;
  });

  // 5. Qualify each row with OpenAI, upsert qualified ones
  let qualifiedInsertedCount = 0;
  const executionId = `upload-${Date.now()}`;
  const now = new Date();

  for (const row of filtered) {
    const bio = row["Biography"] || "";

    let qualification;
    try {
      qualification = await qualifyBio(bio, promptText);
    } catch (err) {
      console.error(
        `OpenAI error for ${row["Username"]}, skipping:`,
        err.message,
      );
      continue;
    }

    if (qualification !== "Qualified") continue;

    const username = String(row["Username"] || "").trim();
    const followingKey = `${username}::${sourceAccount}`;

    await OutboundLead.findOneAndUpdate(
      { username, account_id: accountId },
      {
        $set: {
          followingKey,
          fullName: row["Full name"] || null,
          profileLink: row["Profile link"] || null,
          isVerified: toBoolean(row["Is verified"]),
          followersCount: toNumber(row["Followers count"]),
          bio: row["Biography"] || null,
          postsCount: toNumber(row["Posts count"]),
          externalUrl: row["External url"] || null,
          email: row["Public email"] || row["Email"] || null,
          source: sourceAccount,
          scrapeDate: toDate(scrapeDate),
          ig: row["IG"] || null,
          promptId: promptDoc ? promptDoc._id : null,
          promptLabel: promptDoc ? promptDoc.label : null,
          isMessaged: toBoolean(row["Messaged?"]),
          dmDate: toDate(row["DM Date"]),
          message: row["Message"] || null,
          metadata: {
            source: "nodejs",
            executionId,
            syncedAt: now,
          },
        },
      },
      { upsert: true, new: true },
    );

    qualifiedInsertedCount++;
  }

  // 6. Update IgAccount (increment scrapedCount by total rows in file)
  const accountKey = `instagram::${sourceAccount}`;
  await IgAccount.findOneAndUpdate(
    { accountKey },
    {
      $inc: { scrapedCount: totalRowsParsed },
      $set: {
        name: sourceAccount,
        lastScraped: toDate(scrapeDate),
        metadata: {
          source: "nodejs",
          syncedAt: now,
        },
      },
    },
    { upsert: true, new: true },
  );

  return {
    totalRowsParsed,
    filteredRows: filtered.length,
    qualifiedInsertedCount,
    sourceAccount,
    scrapeDate,
    promptId: promptDoc ? promptDoc._id : null,
    promptLabel: promptDoc ? promptDoc.label : "Default (hardcoded)",
  };
}

module.exports = {
  processUpload,
  parseFilename,
  parseXlsx,
  qualifyBio,
  DEFAULT_QUALIFICATION_PROMPT,
};

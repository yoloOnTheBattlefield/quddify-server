/**
 * One-off script to enrich + qualify the niksetting deep-scrape leads.
 *
 * 1. Fetches all 4,602 leads from the job (no bio data)
 * 2. Batches them through Apify profile scraper (50 at a time)
 * 3. Applies "Coaches and consultants" prompt filters
 * 4. Runs AI qualification via OpenAI on qualifying leads
 * 5. Updates leads in DB
 *
 * Usage: node scripts/enrich-niksetting.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const OpenAI = require("openai");
const {
  PROFILE_SCRAPER,
  startApifyRunWithRotation,
  waitForApifyRun,
  getDatasetItems,
} = require("../services/apifyHelpers");
const { qualifyBio } = require("../services/uploadService");

const JOB_ID = "69daccc391efe20a73ffeacc";
const ACCOUNT_ID = "698783ae7c438c995d1a55d9";
const PROMPT_ID = "699303c5247ca40584255f8d";

const PROMPT_TEXT = `You are an assistant tasked with classifying Instagram bios as either Qualified or Unqualified based on whether the person is likely a coach, consultant, or sells services that relate to personal/business transformation.

For a bio to be Qualified, it must clearly show intent to help others, either via coaching, consulting, mentoring, or services like branding, scaling, teaching, strategy, or content-based growth.

Look for indicators such as:

Service-based keywords: coach, consultant, mentor, trainer, strategist, advisor

Help-indicating language: "I help…", "DM for…", "Work with me…", "Join my program…"

Transformation themes: "build your brand", "scale your business", "fitness coaching", "turn your story into…", "get clients", etc.

B2B/B2C transformation handles or agencies

Personal development or financial growth + offer to guide/support

Return \`Qualified\` if the bio clearly or strongly implies they help others for money. Otherwise, return \`Unqualified\`.`;

// Filters from the prompt config
const MIN_FOLLOWERS = 2000;
const MIN_POSTS = 30;
const EXCLUDE_PRIVATE = true;
const BIO_REQUIRED = true;

const BATCH_SIZE = 50;

async function main() {
  await mongoose.connect(process.env.PROD_DB);
  console.log("Connected to DB");

  const openai = new OpenAI({ apiKey: process.env.OPENAI });

  // 1. Get all leads from this job that haven't been enriched
  const leads = await mongoose.connection.db
    .collection("outbound_leads")
    .find({
      "metadata.executionId": `deep-scrape-${JOB_ID}`,
      ai_processed: { $ne: true },
    })
    .toArray();

  console.log(`Found ${leads.length} unenriched leads`);

  const usernames = leads.map((l) => l.username);

  let stats = {
    profiles_scraped: 0,
    filtered_low_followers: 0,
    filtered_low_posts: 0,
    filtered_private: 0,
    filtered_no_bio: 0,
    sent_to_ai: 0,
    qualified: 0,
    rejected: 0,
    errors: 0,
    profile_not_found: 0,
  };

  // 2. Batch through profile scraper
  for (let i = 0; i < usernames.length; i += BATCH_SIZE) {
    const batch = usernames.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(usernames.length / BATCH_SIZE);

    console.log(`\n── Batch ${batchNum}/${totalBatches} (${batch.length} users) ──`);

    // Start Apify profile scraper
    let run, tokenValue;
    try {
      const result = await startApifyRunWithRotation(
        PROFILE_SCRAPER,
        { usernames: batch },
        ACCOUNT_ID,
        null,
        (msg, level) => console.log(`  [apify] ${msg}`)
      );
      run = result.run;
      tokenValue = result.tokenValue;
    } catch (err) {
      console.error(`  ERROR starting Apify run: ${err.message}`);
      stats.errors += batch.length;
      continue;
    }

    console.log(`  Apify run started: ${run.id}`);

    // Wait for completion
    const completedRun = await waitForApifyRun(run.id, tokenValue);
    if (!completedRun) {
      console.error(`  Run returned null`);
      stats.errors += batch.length;
      continue;
    }

    if (completedRun.status !== "SUCCEEDED") {
      console.warn(`  Run status: ${completedRun.status}`);
    }

    const cost = completedRun.usageTotalUsd ?? 0;
    console.log(`  Run cost: $${cost.toFixed(4)}`);

    // Get profile data
    const profiles = await getDatasetItems(completedRun.defaultDatasetId, tokenValue);
    console.log(`  Got ${profiles.length} profiles`);

    const profileMap = new Map();
    for (const p of profiles) {
      const u = p.username || "";
      if (u) profileMap.set(u.toLowerCase(), p);
    }

    // 3. Process each profile
    for (const username of batch) {
      const profile = profileMap.get(username.toLowerCase());

      if (!profile) {
        stats.profile_not_found++;
        await updateLead(username, {
          qualified: false,
          unqualified_reason: "profile_not_found",
          ai_processed: false,
        });
        continue;
      }

      stats.profiles_scraped++;

      const followerCount = profile.followersCount ?? profile.follower_count ?? 0;
      const bio = profile.biography ?? profile.bio ?? "";
      const postsCount = profile.postsCount ?? profile.mediaCount ?? profile.media_count ?? 0;
      const isPrivate = profile.isPrivate ?? profile.is_private ?? false;
      const isVerified = profile.isVerified ?? profile.is_verified ?? false;
      const externalUrl = profile.externalUrl ?? profile.external_url ?? null;
      const fullName = profile.fullName ?? profile.full_name ?? null;
      const email = profile.businessEmail ?? profile.contactEmail ?? profile.publicEmail ?? null;

      const baseUpdate = {
        fullName,
        bio,
        followersCount: followerCount,
        postsCount,
        isPrivate,
        isVerified,
        externalUrl,
        email,
        promptId: PROMPT_ID,
        promptLabel: "Coaches and consultants",
      };

      // Apply filters
      if (EXCLUDE_PRIVATE && isPrivate) {
        stats.filtered_private++;
        await updateLead(username, {
          ...baseUpdate,
          qualified: false,
          unqualified_reason: "private_account",
          ai_processed: false,
        });
        continue;
      }

      if (followerCount < MIN_FOLLOWERS) {
        stats.filtered_low_followers++;
        await updateLead(username, {
          ...baseUpdate,
          qualified: false,
          unqualified_reason: "low_followers",
          ai_processed: false,
        });
        continue;
      }

      if (postsCount < MIN_POSTS) {
        stats.filtered_low_posts++;
        await updateLead(username, {
          ...baseUpdate,
          qualified: false,
          unqualified_reason: "low_posts",
          ai_processed: false,
        });
        continue;
      }

      if (BIO_REQUIRED && (!bio || bio.trim() === "")) {
        stats.filtered_no_bio++;
        await updateLead(username, {
          ...baseUpdate,
          qualified: false,
          unqualified_reason: "no_bio",
          ai_processed: false,
        });
        continue;
      }

      // 4. AI qualification
      stats.sent_to_ai++;
      try {
        const result = await qualifyBio(bio, PROMPT_TEXT, openai);
        const isQualified = result === "Qualified";

        await updateLead(username, {
          ...baseUpdate,
          qualified: isQualified,
          unqualified_reason: isQualified ? null : "ai_rejected",
          ai_processed: true,
        });

        if (isQualified) {
          stats.qualified++;
          process.stdout.write("✓");
        } else {
          stats.rejected++;
          process.stdout.write("✗");
        }
      } catch (err) {
        console.error(`\n  AI error for @${username}: ${err.message}`);
        await updateLead(username, {
          ...baseUpdate,
          qualified: null,
          unqualified_reason: null,
          ai_processed: false,
        });
        stats.errors++;
      }
    }

    console.log(`\n  Stats so far:`, JSON.stringify(stats));
  }

  // 5. Update the job document stats + enrichment metadata
  await mongoose.connection.db.collection("deep_scrape_jobs").updateOne(
    { _id: new mongoose.Types.ObjectId(JOB_ID) },
    {
      $set: {
        "stats.profiles_scraped": stats.profiles_scraped,
        "stats.filtered_low_followers": stats.filtered_low_followers,
        "stats.sent_to_ai": stats.sent_to_ai,
        "stats.qualified": stats.qualified,
        "stats.rejected": stats.rejected,
        promptId: PROMPT_ID,
        promptLabel: "Coaches and consultants",
        min_followers: MIN_FOLLOWERS,
        enrichment: {
          ran_at: new Date(),
          prompt_used: "Coaches and consultants",
          filters: { MIN_FOLLOWERS, MIN_POSTS, EXCLUDE_PRIVATE, BIO_REQUIRED },
          stats,
        },
      },
    }
  );

  console.log("\n\n═══ FINAL RESULTS ═══");
  console.log(JSON.stringify(stats, null, 2));

  await mongoose.disconnect();
  console.log("Done!");
}

async function updateLead(username, data) {
  await mongoose.connection.db.collection("outbound_leads").updateOne(
    {
      username,
      "metadata.executionId": `deep-scrape-${JOB_ID}`,
    },
    { $set: { ...data, updatedAt: new Date() } }
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

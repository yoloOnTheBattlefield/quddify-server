require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI;

async function migrateSources() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  const collection = db.collection("outbound_leads");

  // Find all leads with dirty source values:
  // - Contains @ prefix
  // - Contains comma (multi-source)
  const dirtyLeads = await collection
    .find({
      source: { $ne: null, $regex: /(@|,)/ },
    })
    .project({ _id: 1, source: 1, source_seeds: 1, metadata: 1 })
    .toArray();

  console.log(`Found ${dirtyLeads.length} leads with dirty source values`);

  let updated = 0;
  let skipped = 0;

  for (const lead of dirtyLeads) {
    // Parse the dirty source: "@seed1, @seed2" or "@@seed1"
    const parts = lead.source
      .split(",")
      .map((p) => p.trim().replace(/^@+/, ""))
      .filter(Boolean);

    if (parts.length === 0) {
      skipped++;
      continue;
    }

    // Use the first seed as the clean source
    const cleanSource = parts[0];

    // Build source_seeds from both existing seeds and parsed parts
    const existingSeeds = lead.source_seeds || [];
    const mergedSeeds = [...new Set([...existingSeeds, ...parts])];

    const updateDoc = {
      $set: {
        source: cleanSource,
        source_seeds: mergedSeeds,
      },
    };

    // Also clean metadata.source if it exists
    if (lead.metadata && lead.metadata.source) {
      updateDoc.$set["metadata.source"] = cleanSource;
    }

    await collection.updateOne({ _id: lead._id }, updateDoc);
    updated++;
  }

  console.log(`Updated: ${updated}, Skipped: ${skipped}`);

  // Also backfill source_seeds for leads that have a clean source but no source_seeds
  const missingSeeds = await collection
    .find({
      source: { $ne: null },
      $or: [{ source_seeds: { $exists: false } }, { source_seeds: { $size: 0 } }],
    })
    .project({ _id: 1, source: 1 })
    .toArray();

  console.log(`\nFound ${missingSeeds.length} leads with source but no source_seeds`);

  let backfilled = 0;
  for (const lead of missingSeeds) {
    const cleanSource = lead.source.replace(/^@+/, "").trim();
    if (!cleanSource) continue;

    await collection.updateOne(
      { _id: lead._id },
      { $set: { source_seeds: [cleanSource] } },
    );
    backfilled++;
  }

  console.log(`Backfilled source_seeds: ${backfilled}`);

  await mongoose.disconnect();
  console.log("\nMigration complete!");
}

migrateSources().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

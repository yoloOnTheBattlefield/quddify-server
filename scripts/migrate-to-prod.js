/**
 * Migrate carousel app data from CRM-DEV → CRM (prod)
 *
 * Collections copied:
 *   - clients (with settings, integrations, brand kit, voice profile)
 *   - client_images (photos with tags/metadata)
 *   - carousels (with slides, confidence, angles)
 *   - carousel_jobs (generation job history)
 *
 * All _id values are preserved so cross-collection references stay valid.
 * Existing documents in prod with the same _id are skipped (idempotent).
 */

const { MongoClient } = require("mongodb");

const SOURCE_URI =
  "mongodb+srv://cristianfloreadev_db_user:SyQG2Lk0qsJYks18@cluster0.jumreey.mongodb.net/CRM-DEV?appName=Cluster0";
const TARGET_URI =
  "mongodb+srv://cristianfloreadev_db_user:SyQG2Lk0qsJYks18@cluster0.jumreey.mongodb.net/CRM?appName=Cluster0";

const COLLECTIONS = ["clients", "client_images", "carousels", "carousel_jobs"];

async function migrate() {
  const src = new MongoClient(SOURCE_URI);
  const tgt = new MongoClient(TARGET_URI);

  try {
    await src.connect();
    await tgt.connect();
    console.log("✓ Connected to both databases\n");

    const srcDb = src.db();
    const tgtDb = tgt.db();

    for (const name of COLLECTIONS) {
      const srcCol = srcDb.collection(name);
      const tgtCol = tgtDb.collection(name);

      const docs = await srcCol.find({}).toArray();
      console.log(`${name}: found ${docs.length} documents in CRM-DEV`);

      if (docs.length === 0) {
        console.log(`  → nothing to migrate\n`);
        continue;
      }

      let inserted = 0;
      let skipped = 0;

      for (const doc of docs) {
        try {
          await tgtCol.insertOne(doc);
          inserted++;
        } catch (err) {
          if (err.code === 11000) {
            // duplicate _id — already exists in prod
            skipped++;
          } else {
            throw err;
          }
        }
      }

      console.log(`  → inserted: ${inserted}, skipped (already exists): ${skipped}\n`);
    }

    console.log("✓ Migration complete");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    await src.close();
    await tgt.close();
  }
}

migrate();

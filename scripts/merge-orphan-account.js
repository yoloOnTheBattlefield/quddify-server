/**
 * Merge the orphan "Cristian Florea" account (CRM-DEV bleed) into the real
 * prod admin account so cristianfloreadev@gmail.com can see Jorden, Nico,
 * and Owen Roddy in the carousel app.
 *
 * Default: DRY RUN (prints intended updates, makes no changes)
 * Apply:   node scripts/merge-orphan-account.js --apply
 *
 * What it does:
 *   - Updates account_id from ORPHAN → REAL on:
 *       clients, carousels, carousel_jobs, client_images, notifications
 *   - Deletes the dangling account_users row in the orphan account
 *     (it points to a non-existent prod user — CRM-DEV bleed)
 *
 * What it does NOT touch:
 *   - The orphan Account document itself (kept on user's request)
 *   - Hayk and any docs already in the real account
 *   - Cristian's real admin account_user row
 *   - Cristian's other role-2 memberships (Josh Crisp, Ahmad, etc.)
 */
const { MongoClient, ObjectId } = require("mongodb");

const PROD_URI =
  "mongodb+srv://cristianfloreadev_db_user:SyQG2Lk0qsJYks18@cluster0.jumreey.mongodb.net/CRM?appName=Cluster0";

const ORPHAN_ACCOUNT = "6993c79a3d2ff2d3048d69fa";
const REAL_ACCOUNT = "698783ae7c438c995d1a55d9";

const COLLECTIONS_TO_REWRITE = [
  "clients",
  "carousels",
  "carousel_jobs",
  "client_images",
  "notifications",
];

const APPLY = process.argv.includes("--apply");

(async () => {
  const client = new MongoClient(PROD_URI);
  await client.connect();
  const db = client.db();
  const orphanObj = new ObjectId(ORPHAN_ACCOUNT);
  const realObj = new ObjectId(REAL_ACCOUNT);

  console.log(`Connected to ${db.databaseName}`);
  console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}`);
  console.log(`Orphan account: ${ORPHAN_ACCOUNT}`);
  console.log(`Real account:   ${REAL_ACCOUNT}\n`);

  // Pre-flight: verify both accounts exist
  const realAcct = await db.collection("accounts").findOne({ _id: realObj });
  if (!realAcct) {
    console.error(`FATAL: real account ${REAL_ACCOUNT} not found`);
    process.exit(1);
  }
  console.log(`Real account verified: "${realAcct.name}"\n`);

  console.log(`=== Per-collection updates ===`);
  let totalUpdated = 0;
  for (const name of COLLECTIONS_TO_REWRITE) {
    const filter = { account_id: orphanObj };
    const matched = await db.collection(name).countDocuments(filter);
    if (matched === 0) {
      console.log(`  ${name}: 0 docs to update — skipping`);
      continue;
    }

    if (APPLY) {
      const res = await db
        .collection(name)
        .updateMany(filter, { $set: { account_id: realObj } });
      console.log(`  ${name}: matched=${res.matchedCount} modified=${res.modifiedCount}`);
      totalUpdated += res.modifiedCount;
    } else {
      console.log(`  ${name}: would update ${matched} doc(s)`);
      totalUpdated += matched;
    }
  }

  console.log(`\n=== Dangling account_users row in orphan ===`);
  const danglingFilter = { account_id: orphanObj };
  const dangling = await db.collection("account_users").find(danglingFilter).toArray();
  console.log(`  found ${dangling.length} row(s)`);
  for (const au of dangling) {
    const u = await db.collection("users").findOne({ _id: au.user_id });
    console.log(
      `    - _id=${au._id}  user_id=${au.user_id}  role=${au.role}  user_exists=${!!u}  email=${u?.email || "<missing>"}`,
    );
  }

  if (dangling.length > 0) {
    if (APPLY) {
      const res = await db.collection("account_users").deleteMany(danglingFilter);
      console.log(`  deleted ${res.deletedCount} row(s)`);
    } else {
      console.log(`  would delete ${dangling.length} row(s)`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  ${APPLY ? "Updated" : "Would update"} ${totalUpdated} doc(s) across ${COLLECTIONS_TO_REWRITE.length} collections`);
  console.log(`  Orphan Account doc itself: KEPT (per user request)`);

  if (!APPLY) {
    console.log(`\nDry run complete. Re-run with --apply to commit.`);
  } else {
    console.log(`\nApply complete. Verify by re-running scripts/investigate-cristian-clients.js against prod.`);
  }

  await client.close();
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});

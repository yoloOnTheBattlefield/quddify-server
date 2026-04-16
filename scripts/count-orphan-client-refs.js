/**
 * READ-ONLY: count related docs for the two orphan-account clients in PROD.
 * Helps decide what needs reassigning when we move Jorden + Owen Roddy from
 * the orphan "Cristian Florea" account to the real one.
 */
const { MongoClient, ObjectId } = require("mongodb");

const PROD_URI =
  "mongodb+srv://cristianfloreadev_db_user:SyQG2Lk0qsJYks18@cluster0.jumreey.mongodb.net/CRM?appName=Cluster0";

const ORPHAN_ACCOUNT = "6993c79a3d2ff2d3048d69fa";
const REAL_ACCOUNT = "698783ae7c438c995d1a55d9";
const CLIENT_IDS = [
  "69aef12ee369e63ad19072a1", // Jorden
  "69cbae3bc49d41051a97d75d", // Owen Roddy
];

(async () => {
  const client = new MongoClient(PROD_URI);
  await client.connect();
  const db = client.db();
  console.log(`Connected to ${db.databaseName}\n`);

  const clientObjIds = CLIENT_IDS.map((id) => new ObjectId(id));
  const orphanObj = new ObjectId(ORPHAN_ACCOUNT);
  const realObj = new ObjectId(REAL_ACCOUNT);

  console.log(`=== Per-collection counts ===\n`);

  // 1. Carousels
  const carByClient = await db.collection("carousels").countDocuments({ client_id: { $in: clientObjIds } });
  const carByOrphan = await db.collection("carousels").countDocuments({ account_id: orphanObj });
  const carByReal = await db.collection("carousels").countDocuments({ account_id: realObj });
  console.log(`carousels:`);
  console.log(`  ${carByClient} doc(s) reference client_id in [Jorden, Owen Roddy]`);
  console.log(`  ${carByOrphan} doc(s) have account_id = orphan`);
  console.log(`  ${carByReal} doc(s) have account_id = real`);

  // 2. CarouselJobs (no client_id field per schema, only account_id)
  const jobByOrphan = await db.collection("carousel_jobs").countDocuments({ account_id: orphanObj });
  const jobByReal = await db.collection("carousel_jobs").countDocuments({ account_id: realObj });
  console.log(`\ncarousel_jobs:`);
  console.log(`  ${jobByOrphan} doc(s) have account_id = orphan`);
  console.log(`  ${jobByReal} doc(s) have account_id = real`);

  // 3. ClientImages
  const imgByClient = await db.collection("client_images").countDocuments({ client_id: { $in: clientObjIds } });
  const imgByOrphan = await db.collection("client_images").countDocuments({ account_id: orphanObj });
  const imgByReal = await db.collection("client_images").countDocuments({ account_id: realObj });
  console.log(`\nclient_images:`);
  console.log(`  ${imgByClient} doc(s) reference client_id in [Jorden, Owen Roddy]`);
  console.log(`  ${imgByOrphan} doc(s) have account_id = orphan`);
  console.log(`  ${imgByReal} doc(s) have account_id = real`);

  // 4. ALL clients in orphan account (sanity check — should only be 2)
  console.log(`\n=== Sanity: all clients in orphan account ===`);
  const orphanClients = await db.collection("clients").find({ account_id: orphanObj }).toArray();
  console.log(`  ${orphanClients.length} client(s):`);
  for (const c of orphanClients) {
    console.log(`    - ${c.name}  (_id=${c._id})`);
  }

  // 5. Anything ELSE in orphan account (carousels with mismatched client_id, etc.)
  console.log(`\n=== Any docs in orphan account NOT tied to Jorden/Owen Roddy? ===`);
  const otherCar = await db.collection("carousels").find({
    account_id: orphanObj,
    client_id: { $nin: clientObjIds },
  }).toArray();
  console.log(`  carousels: ${otherCar.length}`);
  for (const c of otherCar) console.log(`    - _id=${c._id}  client_id=${c.client_id}`);

  const otherImg = await db.collection("client_images").find({
    account_id: orphanObj,
    client_id: { $nin: clientObjIds },
  }).toArray();
  console.log(`  client_images: ${otherImg.length}`);

  // 6. Other collections that might carry account_id (broad sanity check)
  console.log(`\n=== Any other collection with account_id = orphan? ===`);
  const allCollections = await db.listCollections().toArray();
  for (const col of allCollections) {
    const name = col.name;
    if (["clients", "carousels", "carousel_jobs", "client_images"].includes(name)) continue;
    try {
      const n = await db.collection(name).countDocuments({ account_id: orphanObj });
      if (n > 0) console.log(`  ${name}: ${n}`);
    } catch {}
  }

  await client.close();
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});

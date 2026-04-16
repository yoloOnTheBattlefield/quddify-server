/**
 * READ-ONLY: inspect the lone account_user and notification in the orphan account,
 * and look up the mystery client_id 69b0a5c3471adbfe97f1eec0.
 */
const { MongoClient, ObjectId } = require("mongodb");

const PROD_URI =
  "mongodb+srv://cristianfloreadev_db_user:SyQG2Lk0qsJYks18@cluster0.jumreey.mongodb.net/CRM?appName=Cluster0";

const ORPHAN_ACCOUNT = "6993c79a3d2ff2d3048d69fa";
const MYSTERY_CLIENT = "69b0a5c3471adbfe97f1eec0";

(async () => {
  const client = new MongoClient(PROD_URI);
  await client.connect();
  const db = client.db();
  const orphanObj = new ObjectId(ORPHAN_ACCOUNT);

  console.log(`=== Orphan Account doc ===`);
  const acct = await db.collection("accounts").findOne({ _id: orphanObj });
  console.log(acct);

  console.log(`\n=== account_users in orphan ===`);
  const aus = await db.collection("account_users").find({ account_id: orphanObj }).toArray();
  for (const au of aus) {
    const u = await db.collection("users").findOne({ _id: au.user_id });
    console.log(`  - account_user_id=${au._id}  role=${au.role}`);
    console.log(`      user_id=${au.user_id}  email=${u?.email}  name=${u?.first_name} ${u?.last_name}`);
  }

  console.log(`\n=== notifications in orphan ===`);
  const notifs = await db.collection("notifications").find({ account_id: orphanObj }).toArray();
  for (const n of notifs) {
    console.log(`  -`, n);
  }

  console.log(`\n=== mystery client_id ${MYSTERY_CLIENT} ===`);
  const mc = await db.collection("clients").findOne({ _id: new ObjectId(MYSTERY_CLIENT) });
  console.log(mc ? `  found: name=${mc.name} account_id=${mc.account_id}` : `  NOT FOUND (deleted)`);

  await client.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

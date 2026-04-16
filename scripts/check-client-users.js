/**
 * READ-ONLY: for every Client doc currently in cristian's real admin account,
 * find the linked client user (if any) and where their AccountUser points.
 * Tells us which client users are stranded after the orphan→real merge.
 */
const { MongoClient, ObjectId } = require("mongodb");

const PROD_URI =
  "mongodb+srv://cristianfloreadev_db_user:SyQG2Lk0qsJYks18@cluster0.jumreey.mongodb.net/CRM?appName=Cluster0";

const REAL_ACCOUNT = "698783ae7c438c995d1a55d9";
const ORPHAN_ACCOUNT = "6993c79a3d2ff2d3048d69fa";

(async () => {
  const client = new MongoClient(PROD_URI);
  await client.connect();
  const db = client.db();
  const realObj = new ObjectId(REAL_ACCOUNT);

  console.log(`Connected to ${db.databaseName}\n`);

  const clients = await db.collection("clients").find({ account_id: realObj }).toArray();
  console.log(`Clients in real account: ${clients.length}\n`);

  for (const c of clients) {
    console.log(`--- ${c.name}  (_id=${c._id}) ---`);
    if (!c.user_id) {
      console.log(`  no linked user`);
      continue;
    }
    const u = await db.collection("users").findOne({ _id: c.user_id });
    console.log(`  linked user: ${u?.email || "<missing>"}  (user_id=${c.user_id})`);
    if (!u) continue;
    const memberships = await db.collection("account_users").find({ user_id: u._id }).toArray();
    console.log(`  memberships: ${memberships.length}`);
    for (const m of memberships) {
      const acct = await db.collection("accounts").findOne({ _id: m.account_id });
      const tag =
        m.account_id.toString() === REAL_ACCOUNT
          ? " <-- REAL"
          : m.account_id.toString() === ORPHAN_ACCOUNT
            ? " <-- ORPHAN"
            : "";
      console.log(`    - account_id=${m.account_id}  role=${m.role}  name="${acct?.name || "<missing>"}"${tag}`);
    }
  }

  await client.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

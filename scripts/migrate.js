require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI;

async function migrate() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;

  // Read all old account documents (raw, bypassing Mongoose schema)
  const oldAccounts = await db.collection("accounts").find().toArray();
  console.log(`Found ${oldAccounts.length} old account documents`);

  // Separate owners (no parent_id) from team members (has parent_id)
  const owners = oldAccounts.filter((a) => !a.parent_id);
  const teamMembers = oldAccounts.filter((a) => a.parent_id);

  console.log(`Owners: ${owners.length}, Team members: ${teamMembers.length}`);

  // Map old account _id -> new account _id
  const accountIdMap = {};

  // Create new Account docs (org only) and User docs (person) for owners
  for (const old of owners) {
    const newAccount = {
      ghl: old.ghl || null,
      calendly: old.calendly || null,
      calendly_token: old.calendly_token || null,
      ghl_lead_booked_webhook: old.ghl_lead_booked_webhook || null,
    };

    const result = await db.collection("accounts_new").insertOne(newAccount);
    const newAccountId = result.insertedId;
    accountIdMap[old._id.toString()] = newAccountId;

    await db.collection("users").insertOne({
      account_id: newAccountId,
      first_name: old.first_name || null,
      last_name: old.last_name || null,
      email: old.email,
      password: old.password,
      role: old.role != null ? old.role : 1,
    });

    console.log(`Migrated owner: ${old.email} -> account ${newAccountId}`);
  }

  // Create User docs for team members
  for (const old of teamMembers) {
    const parentNewId = accountIdMap[old.parent_id.toString()];

    if (!parentNewId) {
      console.warn(`Skipping team member ${old.email} - parent ${old.parent_id} not found`);
      continue;
    }

    await db.collection("users").insertOne({
      account_id: parentNewId,
      first_name: old.first_name || null,
      last_name: old.last_name || null,
      email: old.email,
      password: old.password,
      role: old.role || 2,
    });

    console.log(`Migrated team member: ${old.email} -> account ${parentNewId}`);
  }

  // Rename collections: backup old, swap new into place
  console.log("\nSwapping collections...");
  await db.collection("accounts").rename("accounts_old");
  await db.collection("accounts_new").rename("accounts");

  console.log("\nMigration complete!");
  console.log("Old accounts backed up in 'accounts_old' collection.");
  console.log("You can drop 'accounts_old' once you verify everything works.");

  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

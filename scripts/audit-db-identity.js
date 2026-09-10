/**
 * READ-ONLY. Identifies which database the local .env points at and how much
 * real Instagram activity it holds. Prints no credentials. Writes nothing.
 */
require("dotenv").config();
const mongoose = require("mongoose");

async function audit() {
  await mongoose.connect(process.env.MONGO_URI);

  const { name, host } = mongoose.connection;
  console.log(`Database: ${name}`);
  console.log(`Host:     ${host}`);

  const db = mongoose.connection.db;
  const names = (await db.listCollections().toArray()).map((c) => c.name).sort();

  const interesting = [
    "leads",
    "outbound_leads",
    "ig_conversations",
    "ig_messages",
    "accounts",
    "comment_rules",
    "comment_events",
    "bookings",
  ];

  console.log("\nCounts:");
  for (const c of interesting) {
    if (!names.includes(c)) {
      console.log(`  ${c}: (collection does not exist)`);
      continue;
    }
    console.log(`  ${c}: ${await db.collection(c).countDocuments()}`);
  }

  console.log(`\nTotal collections: ${names.length}`);
  console.log("\nREAD-ONLY — nothing was modified.");
  await mongoose.disconnect();
}

audit().catch((err) => {
  console.error(err);
  process.exit(1);
});

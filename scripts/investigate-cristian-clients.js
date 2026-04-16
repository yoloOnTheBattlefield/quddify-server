/**
 * READ-ONLY investigation: figure out why cristianfloreadev@gmail.com only sees
 * Hayk and not Jorden / Roddy in the carousel app.
 *
 * Prints:
 *   - every User row with that email
 *   - every AccountUser binding for those users
 *   - the Account name for each binding
 *   - every Client doc whose name matches Hayk / Jorden / Roddy with their
 *     account_id, user_id, and the owning Account name
 *
 * Usage:
 *   node scripts/investigate-cristian-clients.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/User");
const Account = require("../models/Account");
const AccountUser = require("../models/AccountUser");
const Client = require("../models/Client");

const TARGET_EMAIL = "cristianfloreadev@gmail.com";
const NAME_REGEX = /hayk|jorden|jordan|roddy/i;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.db.databaseName}\n`);

  // 1. Users with that email (case-insensitive)
  const users = await User.find({
    email: { $regex: `^${TARGET_EMAIL}$`, $options: "i" },
  }).lean();
  console.log(`=== Users matching ${TARGET_EMAIL} ===`);
  console.log(`Found ${users.length} user row(s)`);
  for (const u of users) {
    console.log(`  - _id=${u._id}  email=${u.email}  account_id=${u.account_id}  name=${u.first_name || ""} ${u.last_name || ""}`);
  }
  console.log();

  // 2. AccountUser memberships for each
  console.log(`=== AccountUser memberships ===`);
  for (const u of users) {
    const memberships = await AccountUser.find({ user_id: u._id }).lean();
    console.log(`  user ${u._id} -> ${memberships.length} membership(s)`);
    for (const m of memberships) {
      const account = await Account.findById(m.account_id).lean();
      console.log(`    - account_id=${m.account_id}  role=${m.role}  account_name="${account?.name || "<missing>"}"`);
    }
  }
  console.log();

  // 3. All clients matching the names
  console.log(`=== Client docs matching /${NAME_REGEX.source}/ ===`);
  const clients = await Client.find({ name: { $regex: NAME_REGEX } }).lean();
  console.log(`Found ${clients.length} client(s)`);
  for (const c of clients) {
    const account = await Account.findById(c.account_id).lean();
    let creatorEmail = null;
    if (c.user_id) {
      const cu = await User.findById(c.user_id).lean();
      creatorEmail = cu?.email || null;
    }
    console.log(`  - name="${c.name}"  _id=${c._id}`);
    console.log(`      account_id=${c.account_id}  account_name="${account?.name || "<missing>"}"`);
    console.log(`      user_id=${c.user_id || "<none>"}  user_email=${creatorEmail || "<none>"}`);
    console.log(`      created_at=${c.created_at}`);
  }
  console.log();

  // 4. For each cristian user, what clients they would currently see via the API
  console.log(`=== Clients that cristian would currently see (per AccountUser membership) ===`);
  for (const u of users) {
    const memberships = await AccountUser.find({ user_id: u._id }).lean();
    for (const m of memberships) {
      const visible = await Client.find({ account_id: m.account_id }).lean();
      console.log(`  membership account_id=${m.account_id}  role=${m.role}  -> ${visible.length} client(s):`);
      for (const v of visible) {
        console.log(`     * ${v.name}  (_id=${v._id})`);
      }
    }
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});

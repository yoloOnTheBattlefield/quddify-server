/**
 * One-shot migration: isolate client users into their own Accounts.
 *
 * Background
 * ----------
 * `POST /api/clients` used to add the newly-provisioned client user as a
 * member (role 2) of the CREATOR's account. Only the `/clients` list route
 * applied role-2 scoping, so when a client user logged in they would see all
 * of the creator's data (bookings, outbound leads, analytics, etc.) because
 * every other data route filters only by `account_id`.
 *
 * This script finds every Client document that has a linked `user_id` whose
 * AccountUser is still pointing at the creator's account, provisions a new
 * dedicated Account for that user, and moves their AccountUser + User.account_id
 * over to the new account. The Client document itself stays in the creator's
 * account so the creator keeps managing it.
 *
 * Usage
 * -----
 *   # dry run (default): prints what would change
 *   node scripts/isolate-client-users.js
 *
 *   # apply:
 *   node scripts/isolate-client-users.js --apply
 *
 *   # limit to a single user by email:
 *   node scripts/isolate-client-users.js --email hayk.simonyan.email@gmail.com --apply
 */

require("dotenv").config();
const mongoose = require("mongoose");

const Client = require("../models/Client");
const User = require("../models/User");
const Account = require("../models/Account");
const AccountUser = require("../models/AccountUser");

const APPLY = process.argv.includes("--apply");
const emailArgIdx = process.argv.indexOf("--email");
const EMAIL = emailArgIdx >= 0 ? process.argv[emailArgIdx + 1] : null;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.db.databaseName}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}${EMAIL ? ` (email=${EMAIL})` : ""}`);

  const clientQuery = { user_id: { $ne: null } };
  if (EMAIL) clientQuery.email = EMAIL.toLowerCase();
  const clients = await Client.find(clientQuery).lean();

  console.log(`Found ${clients.length} Client rows with a linked user.`);

  let migrated = 0;
  let skipped = 0;
  for (const client of clients) {
    const user = await User.findById(client.user_id).lean();
    if (!user) {
      console.log(`  - client ${client._id} (${client.name}): user ${client.user_id} missing, skipping`);
      skipped++;
      continue;
    }

    const memberships = await AccountUser.find({ user_id: user._id }).lean();
    if (memberships.length === 0) {
      console.log(`  - ${user.email}: no AccountUser rows, skipping`);
      skipped++;
      continue;
    }

    // Is this user already isolated? (i.e. their only membership is NOT the
    // creator's account). The creator's account == client.account_id.
    const onCreatorAccount = memberships.filter((m) => String(m.account_id) === String(client.account_id));
    if (onCreatorAccount.length === 0) {
      console.log(`  - ${user.email}: already isolated, skipping`);
      skipped++;
      continue;
    }

    // Provision a fresh Account and move the user onto it.
    console.log(
      `  * ${user.email}: currently on creator account ${client.account_id} — will migrate to a new isolated account`,
    );

    if (!APPLY) {
      migrated++;
      continue;
    }

    const newAccount = await Account.create({ name: client.name });

    // Delete the bad membership(s) pointing at the creator's account.
    await AccountUser.deleteMany({
      user_id: user._id,
      account_id: client.account_id,
    });

    // Create a fresh membership in the new isolated account.
    await AccountUser.create({
      user_id: user._id,
      account_id: newAccount._id,
      role: 1,
      is_default: true,
    });

    // Update User.account_id to match.
    await User.updateOne({ _id: user._id }, { $set: { account_id: newAccount._id } });

    console.log(`    -> migrated ${user.email} to account ${newAccount._id}`);
    migrated++;
  }

  console.log(`\nDone. ${APPLY ? "Migrated" : "Would migrate"}: ${migrated}. Skipped: ${skipped}.`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

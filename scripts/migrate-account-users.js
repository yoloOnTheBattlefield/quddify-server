/**
 * Migration: Populate account_users pivot table from existing User records.
 *
 * For every User:
 *   1. Create an AccountUser linking user_id → account_id
 *   2. Copy role, has_outbound from User to AccountUser
 *   3. Set is_default = true (existing account becomes default)
 *
 * For every Account:
 *   1. Set account.name from the owner User's name (role ≤ 1)
 *
 * Idempotent: skips if AccountUser already exists for a user+account pair.
 *
 * Usage:
 *   MONGO_URI=mongodb+srv://... node scripts/migrate-account-users.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const Account = require("../models/Account");
const AccountUser = require("../models/AccountUser");

async function migrate() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI env var is required");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  // --- Step 1: Create AccountUser records ---
  const users = await User.find().lean();
  console.log(`Found ${users.length} users`);

  let created = 0;
  let skipped = 0;

  for (const user of users) {
    if (!user.account_id) {
      console.log(`  SKIP user ${user.email} — no account_id`);
      skipped++;
      continue;
    }

    const exists = await AccountUser.findOne({
      user_id: user._id,
      account_id: user.account_id,
    });

    if (exists) {
      skipped++;
      continue;
    }

    await AccountUser.create({
      user_id: user._id,
      account_id: user.account_id,
      role: user.role ?? 1,
      has_outbound: user.has_outbound ?? false,
      has_research: true,
      is_default: true,
    });
    created++;
  }

  console.log(`AccountUser records: ${created} created, ${skipped} skipped`);

  // --- Step 2: Set account.name from owner ---
  const accounts = await Account.find().lean();
  let namesSet = 0;

  for (const account of accounts) {
    if (account.name) continue; // already has a name

    const owner = await User.findOne(
      { account_id: account._id, role: { $lte: 1 } },
      { first_name: 1, last_name: 1, email: 1 },
    ).lean();

    if (!owner) continue;

    const name =
      `${owner.first_name || ""} ${owner.last_name || ""}`.trim() ||
      owner.email;

    await Account.findByIdAndUpdate(account._id, { name });
    namesSet++;
  }

  console.log(`Account names set: ${namesSet}`);
  console.log("Migration complete");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

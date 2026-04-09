/**
 * READ-ONLY investigation: figure out why coachowenroddy@gmail.com cannot see
 * his carousels or images in the carousel app.
 *
 * Prints:
 *   - User row(s) for the email
 *   - AccountUser memberships and their account names
 *   - Client doc(s) where user_id matches that user
 *   - Client doc(s) whose name matches /roddy/i (in case user_id was never backfilled)
 *   - Carousel + ClientImage counts in his isolated account vs in his Client's account
 *
 * Usage:
 *   node scripts/investigate-owen-roddy.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/User");
const Account = require("../models/Account");
const AccountUser = require("../models/AccountUser");
const Client = require("../models/Client");
const Carousel = require("../models/Carousel");
const ClientImage = require("../models/ClientImage");

const TARGET_EMAIL = "coachowenroddy@gmail.com";
const NAME_REGEX = /roddy|owen/i;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.db.databaseName}\n`);

  // 1. Users with that email
  const users = await User.find({
    email: { $regex: `^${TARGET_EMAIL}$`, $options: "i" },
  }).lean();
  console.log(`=== Users matching ${TARGET_EMAIL} ===`);
  console.log(`Found ${users.length} user row(s)`);
  for (const u of users) {
    console.log(`  - _id=${u._id}  email=${u.email}  account_id=${u.account_id}  name=${u.first_name || ""} ${u.last_name || ""}`);
  }
  console.log();

  // 2. AccountUser memberships
  console.log(`=== AccountUser memberships ===`);
  for (const u of users) {
    const memberships = await AccountUser.find({ user_id: u._id }).lean();
    console.log(`  user ${u._id} -> ${memberships.length} membership(s)`);
    for (const m of memberships) {
      const account = await Account.findById(m.account_id).lean();
      console.log(`    - account_id=${m.account_id}  role=${m.role}  is_default=${m.is_default}  account_name="${account?.name || "<missing>"}"`);
    }
  }
  console.log();

  // 3. Client docs by user_id
  console.log(`=== Client docs where user_id == owen.user._id ===`);
  for (const u of users) {
    const clients = await Client.find({ user_id: u._id }).lean();
    console.log(`  user ${u._id} -> ${clients.length} client(s)`);
    for (const c of clients) {
      const account = await Account.findById(c.account_id).lean();
      console.log(`    - name="${c.name}"  _id=${c._id}  account_id=${c.account_id}  account_name="${account?.name || "<missing>"}"`);
    }
  }
  console.log();

  // 4. Client docs by name (in case user_id is null/missing)
  console.log(`=== Client docs matching /${NAME_REGEX.source}/ ===`);
  const clientsByName = await Client.find({ name: { $regex: NAME_REGEX } }).lean();
  console.log(`Found ${clientsByName.length} client(s)`);
  for (const c of clientsByName) {
    const account = await Account.findById(c.account_id).lean();
    let userEmail = null;
    if (c.user_id) {
      const cu = await User.findById(c.user_id).lean();
      userEmail = cu?.email || null;
    }
    console.log(`  - name="${c.name}"  _id=${c._id}  email=${c.email || "<none>"}`);
    console.log(`      account_id=${c.account_id}  account_name="${account?.name || "<missing>"}"`);
    console.log(`      user_id=${c.user_id || "<none>"}  linked_user_email=${userEmail || "<none>"}`);
  }
  console.log();

  // 5. Carousel + ClientImage counts: isolated account vs creator account
  console.log(`=== Data counts ===`);
  for (const u of users) {
    const memberships = await AccountUser.find({ user_id: u._id }).lean();
    for (const m of memberships) {
      const carCount = await Carousel.countDocuments({ account_id: m.account_id });
      const imgCount = await ClientImage.countDocuments({ account_id: m.account_id });
      console.log(`  isolated account ${m.account_id}: ${carCount} carousels, ${imgCount} images`);
    }
  }
  for (const c of clientsByName) {
    const carCount = await Carousel.countDocuments({ client_id: c._id });
    const imgCount = await ClientImage.countDocuments({ client_id: c._id });
    console.log(`  client "${c.name}" ${c._id}: ${carCount} carousels, ${imgCount} images (by client_id)`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});

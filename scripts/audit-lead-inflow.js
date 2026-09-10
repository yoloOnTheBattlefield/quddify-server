/**
 * READ-ONLY. Answers "are inbound leads still arriving, and from where?"
 * Breaks recent Lead creation down by source and by day. Writes nothing.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Account = require("../models/Account");
const Lead = require("../models/Lead");

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

async function audit() {
  await mongoose.connect(process.env.MONGO_URI);

  const total = await Lead.countDocuments({});
  console.log(`Total leads: ${total}`);

  const newest = await Lead.find({})
    .sort({ date_created: -1 })
    .limit(5)
    .select("ig_username source date_created account_id")
    .lean();

  console.log("\nMost recent 5 by date_created:");
  for (const l of newest) {
    console.log(`  ${l.date_created}  ${l.source || "(no source)"}  @${l.ig_username || "-"}`);
  }

  for (const window of [1, 7, 30]) {
    const since = daysAgoIso(window);
    const rows = await Lead.aggregate([
      { $match: { date_created: { $gte: since } } },
      { $group: { _id: "$source", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    const sum = rows.reduce((acc, r) => acc + r.n, 0);
    console.log(`\nLast ${window}d — ${sum} lead(s)`);
    for (const r of rows) console.log(`  ${r._id || "(no source)"}: ${r.n}`);
  }

  const accounts = await Account.find({})
    .select("_id name ghl ig_oauth.ig_user_id ig_oauth.ig_username zernio.enabled")
    .lean();

  console.log("\nAccounts and their Instagram connection:");
  for (const a of accounts) {
    const ig = a.ig_oauth?.ig_username || a.ig_oauth?.ig_user_id;
    console.log(
      `  ${a.name || "(unnamed)"} — meta: ${ig ? `@${ig}` : "not connected"}, zernio: ${a.zernio?.enabled ? "on" : "off"}`,
    );
  }

  console.log("\nREAD-ONLY — nothing was modified.");
  await mongoose.disconnect();
}

audit().catch((err) => {
  console.error(err);
  process.exit(1);
});

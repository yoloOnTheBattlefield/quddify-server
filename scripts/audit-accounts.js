/**
 * READ-ONLY. Lists accounts with their id, name and Instagram connection state,
 * so a connect script can be pointed at the right one. Writes nothing.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Account = require("../models/Account");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const accounts = await Account.find({ deleted: { $ne: true } })
    .select("_id name ghl ig_oauth.ig_username zernio.enabled zernio.ig_username")
    .lean();

  for (const a of accounts) {
    const meta = a.ig_oauth?.ig_username ? `@${a.ig_oauth.ig_username}` : "-";
    const zern = a.zernio?.enabled ? `@${a.zernio.ig_username || "?"}` : "off";
    console.log(`${a._id.toString()}  meta:${meta.padEnd(22)} zernio:${zern.padEnd(12)} ${a.name || "(unnamed)"}`);
  }

  console.log("\nREAD-ONLY — nothing was modified.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

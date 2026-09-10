/**
 * READ-ONLY audit. Counts leads whose account_id is a raw GHL location id
 * instead of the CRM Account._id string, per account. Those leads exist in the
 * database but never appear in the UI, because every read path filters on
 * Account._id.toString().
 *
 * Writes nothing. Run scripts/heal-lead-account-ids.js to actually fix them.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Account = require("../models/Account");
const Lead = require("../models/Lead");

async function audit() {
  await mongoose.connect(process.env.MONGO_URI);

  const accounts = await Account.find({ ghl: { $exists: true, $ne: null } })
    .select("_id ghl name")
    .lean();

  console.log(`Accounts with a ghl field: ${accounts.length}`);
  console.log("");

  let totalHidden = 0;
  let totalVisible = 0;

  for (const acc of accounts) {
    const correctId = acc._id.toString();
    const [hidden, visible] = await Promise.all([
      Lead.countDocuments({ account_id: acc.ghl }),
      Lead.countDocuments({ account_id: correctId }),
    ]);

    totalHidden += hidden;
    totalVisible += visible;

    if (hidden > 0) {
      console.log(
        `  ${acc.name || "(unnamed)"} [${correctId}] — HIDDEN: ${hidden}, visible: ${visible}`,
      );
    }
  }

  const orphaned = await Lead.countDocuments({
    account_id: { $nin: [...accounts.map((a) => a._id.toString()), ...accounts.map((a) => a.ghl)] },
  });

  console.log("");
  console.log(`Total hidden (stored under a GHL id): ${totalHidden}`);
  console.log(`Total visible (stored under an ObjectId): ${totalVisible}`);
  console.log(`Leads on some other/unknown account_id: ${orphaned}`);
  console.log("");
  console.log("READ-ONLY — nothing was modified.");

  await mongoose.disconnect();
}

audit().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * One-off: bring contacts the agent wrote before 2026-11-14 in line with the dashboard.
 *
 *   railway run node scripts/backfill-agent-funnel.js --account <AccountId> [--apply]
 *
 * For every Instagram lead on the account it links the stored DM thread (first/last inbound,
 * date_created = first real message) and fills the funnel dates its stage implies.
 * Without --apply it only prints what it would change. Never touches LinkedIn leads.
 */
const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const { linkConversations, applyStageDates } = require("../routes/agent");

const args = process.argv.slice(2);
const accountId = args[args.indexOf("--account") + 1];
const apply = args.includes("--apply");
const FIELDS = ["date_created", "first_conversation_at", "last_inbound_at", "messaged_at", "replied_at", "link_sent_at", "booked_at", "closed_at", "disqualified_at"];

async function main() {
  if (!accountId || !mongoose.isValidObjectId(accountId)) throw new Error("--account <AccountId> required");
  await mongoose.connect(process.env.MONGO_URI);
  const leads = await Lead.find({ account_id: accountId, platform: { $ne: "linkedin" }, source: { $ne: "linkedin-extension" } });
  const changed = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  let touched = 0;

  for (const lead of leads) {
    const before = Object.fromEntries(FIELDS.map((f) => [f, lead[f] ? String(lead[f]) : null]));
    if (apply) await linkConversations(accountId, lead);
    const at = (lead.stage_history || []).filter((h) => h.to === lead.stage).map((h) => h.at).pop()
      || lead.last_inbound_at || (lead.date_created ? new Date(lead.date_created) : new Date());
    applyStageDates(lead, lead.stage || "new", at);
    const diff = FIELDS.filter((f) => (lead[f] ? String(lead[f]) : null) !== before[f]);
    if (!diff.length) continue;
    touched++;
    diff.forEach((f) => changed[f]++);
    if (apply) await Lead.updateOne({ _id: lead._id }, { $set: Object.fromEntries(diff.map((f) => [f, lead[f]])) });
  }

  console.log(`${apply ? "updated" : "would update"} ${touched}/${leads.length} leads`, JSON.stringify(changed));
  if (!apply) console.log("(dry run: thread linking only happens with --apply)");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

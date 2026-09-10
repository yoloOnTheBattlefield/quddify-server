/**
 * READ-ONLY. Fetches recent media for an account and probes which insight
 * metrics the Graph API version actually accepts. Writes nothing.
 *
 *   railway run node scripts/probe-ig-insights.js --account <AccountId>
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Account = require("../models/Account");
const { decrypt } = require("../utils/crypto");
const insights = require("../services/instagramInsights");

async function main() {
  const args = process.argv.slice(2);
  const accountId = args[args.indexOf("--account") + 1];
  if (!accountId) throw new Error("Pass --account <AccountId>");

  await mongoose.connect(process.env.MONGO_URI);
  const account = await Account.findById(accountId).select("name ig_oauth").lean();
  if (!account) throw new Error("No such account");

  const token = decrypt(account.ig_oauth?.page_access_token);
  const igUserId = account.ig_oauth?.ig_user_id;
  if (!token || !igUserId) throw new Error("No Meta connection on this account");

  console.log(`Account: ${account.name} (@${account.ig_oauth.ig_username})`);

  const media = await insights.fetchAccountMedia({ igUserId, token, days: 90 });
  console.log(`Media in last 90d: ${media.length}`);

  const byType = {};
  for (const m of media) {
    byType[m.media_product_type] = (byType[m.media_product_type] || 0) + 1;
  }
  console.log("By type:", JSON.stringify(byType));

  if (media.length === 0) {
    await mongoose.disconnect();
    return;
  }

  const sample = media[0];
  console.log(`\nSample post ${sample.id} (${sample.media_product_type})`);
  console.log(`  likes=${sample.like_count} comments=${sample.comments_count}`);
  console.log(`  permalink=${sample.permalink}`);

  // Probe each metric on its own, so one bad name doesn't hide the rest.
  console.log("\nPer-metric probe:");
  for (const metric of insights.metricsFor(sample.media_product_type)) {
    const res = await fetch(
      `${insights.GRAPH}/${sample.id}/insights?metric=${metric}&access_token=${token}`,
    );
    const data = await res.json();
    if (data.error) {
      console.log(`  ${metric.padEnd(20)} REJECTED: ${data.error.message}`);
    } else {
      console.log(`  ${metric.padEnd(20)} ok = ${data.data?.[0]?.values?.[0]?.value}`);
    }
  }

  console.log("\nREAD-ONLY — nothing was modified.");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(`FAILED: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

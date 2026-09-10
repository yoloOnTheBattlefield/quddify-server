/**
 * Creates one comment-automation rule from the command line.
 *
 *   node scripts/create-comment-rule.js \
 *     --account <AccountId> --ig <ig_user_id> \
 *     --name "Free guide" --keywords "guide,send" \
 *     --dm "Hey {{firstName}}, here it is: {{link}}" \
 *     [--link https://…] [--mode whole|partial] [--apply]
 *
 * Dry run by default. Run under `railway run` to target production.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const CommentRule = require("../models/CommentRule");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

async function main() {
  const accountId = flag("account");
  const igUserId = flag("ig");
  const dmText = flag("dm");
  const keywords = (flag("keywords") || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  if (!accountId || !igUserId || !dmText || keywords.length === 0) {
    throw new Error("Need --account, --ig, --keywords and --dm");
  }

  const doc = {
    account_id: accountId,
    ig_user_id: igUserId,
    name: flag("name", "Untitled"),
    keywords,
    match_mode: flag("mode", "partial"),
    dm_text: dmText,
    link_url: flag("link"),
    reply_publicly: false,
    public_replies: [],
    active: true,
  };

  console.log("Rule to create:");
  console.log(JSON.stringify(doc, null, 2));

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    return;
  }

  await mongoose.connect(process.env.MONGO_URI);
  const rule = await CommentRule.create(doc);
  console.log(`\nCreated rule ${rule._id}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(`\nFAILED: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

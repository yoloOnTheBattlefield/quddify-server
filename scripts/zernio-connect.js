/**
 * One-off Zernio connect.
 *
 *   ZERNIO_KEY=... node scripts/zernio-connect.js --account <AccountId> [--apply]
 *
 * Without --apply it only reads: lists profiles and Instagram accounts and
 * prints what it would do. With --apply it registers the webhook with Zernio
 * and writes the encrypted connection onto the Account.
 *
 * Run under `railway run` so MONGO_URI and ENCRYPTION_KEY come from production;
 * without ENCRYPTION_KEY the stored key would be written in plaintext.
 */
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");
const Account = require("../models/Account");
const { encrypt, decrypt } = require("../utils/crypto");
const zernioClient = require("../services/zernioClient");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const accountId = args[args.indexOf("--account") + 1];
const apiKey = process.env.ZERNIO_KEY;

const PUBLIC_URL =
  process.env.PUBLIC_SERVER_URL ||
  process.env.SERVER_URL ||
  "https://quddify-server-production.up.railway.app";

async function main() {
  if (!apiKey) throw new Error("Set ZERNIO_KEY in the environment");
  if (!accountId) throw new Error("Pass --account <AccountId>");

  if (!process.env.ENCRYPTION_KEY) {
    throw new Error(
      "ENCRYPTION_KEY is not set — refusing to write the API key in plaintext. Run under `railway run`.",
    );
  }

  await mongoose.connect(process.env.MONGO_URI);

  const account = await Account.findById(accountId).select("name ghl ig_oauth zernio");
  if (!account) throw new Error(`No account ${accountId}`);
  console.log(`Account: ${account.name || "(unnamed)"} [${account._id}]`);
  console.log(
    `Meta Instagram: ${account.ig_oauth?.ig_username ? "@" + account.ig_oauth.ig_username : "not connected"}`,
  );

  console.log("\nListing Zernio profiles…");
  const profiles = await zernioClient.listProfiles(apiKey);
  if (profiles.length === 0) throw new Error("This key can see no Zernio profiles");
  for (const p of profiles) console.log(`  ${p.name} [${p.id}]`);

  let chosen = null;
  for (const profile of profiles) {
    const accounts = await zernioClient.listInstagramAccounts({ apiKey, profileId: profile.id });
    console.log(`\nInstagram accounts on "${profile.name}": ${accounts.length}`);
    for (const a of accounts) {
      console.log(`  @${a.username}  ig_user_id=${a.ig_user_id}  zernio_account_id=${a.id}`);
      if (!chosen) chosen = { profile, account: a };
    }
  }

  if (!chosen) throw new Error("No active Instagram accounts on any profile for this key");

  const webhookUrl = new URL(`/zernio-webhook/${account._id}`, PUBLIC_URL).toString();
  console.log(`\nWould bind: @${chosen.account.username} → ${account.name}`);
  console.log(`Webhook URL: ${webhookUrl}`);

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
    await mongoose.disconnect();
    return;
  }

  const secret =
    decrypt(account.zernio?.webhook_secret) || crypto.randomBytes(32).toString("hex");

  console.log("\nRegistering webhook with Zernio…");
  const webhookId = await zernioClient.ensureWebhook({
    apiKey,
    url: webhookUrl,
    secret,
    webhookId: account.zernio?.webhook_id || null,
  });
  console.log(`  webhook id: ${webhookId}`);

  await Account.findByIdAndUpdate(account._id, {
    $set: {
      "zernio.api_key": encrypt(apiKey),
      "zernio.profile_id": chosen.profile.id,
      "zernio.zernio_account_id": chosen.account.id,
      "zernio.ig_user_id": chosen.account.ig_user_id,
      "zernio.ig_username": chosen.account.username,
      "zernio.webhook_id": webhookId,
      "zernio.webhook_secret": encrypt(secret),
      "zernio.enabled": true,
      "zernio.connected_at": new Date(),
    },
  });

  console.log(`\nConnected. @${chosen.account.username} now routes through Zernio.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(`\nFAILED: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

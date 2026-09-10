/**
 * READ-ONLY. Lists the webhooks registered on a Zernio account, so you can see
 * exactly what URL Zernio will POST to. Writes nothing.
 *
 *   ZERNIO_KEY=... node scripts/audit-zernio-webhooks.js
 */
const zernioClient = require("../services/zernioClient");

async function main() {
  const apiKey = process.env.ZERNIO_KEY;
  if (!apiKey) throw new Error("Set ZERNIO_KEY in the environment");

  const webhooks = await zernioClient.listWebhooks(apiKey);
  if (webhooks.length === 0) {
    console.log("No webhooks registered.");
    return;
  }

  for (const w of webhooks) {
    const scheme = w.url.startsWith("https://") ? "https" : "NOT HTTPS";
    console.log(`${w._id}  [${scheme}]  ${w.url}`);
  }

  console.log("\nREAD-ONLY — nothing was modified.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

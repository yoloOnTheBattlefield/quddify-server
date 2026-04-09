/**
 * One-shot setup for the /api/ghl/match-outbound endpoint.
 *
 * For a given GHL location:
 *   1. Fetches the location's custom fields from LeadConnector
 *   2. Finds the IG_username and IG_bio fields by name
 *   3. Encrypts the PIT token and saves it (+ the two field IDs) on the
 *      matching Account doc
 *
 * Usage:
 *   GHL_LOCATION_ID=jvravdPl2VbTHveU1qEA \
 *   GHL_PIT_TOKEN=pit-dffa4ac5-6fe3-4f5e-8bc1-f1916fc46c96 \
 *   MONGO_URI="mongodb+srv://..." \
 *   node scripts/setup-ghl-match.js
 *
 * Re-run safely whenever you rotate the PIT token or rename a field.
 */
const mongoose = require("mongoose");
const Account = require("../models/Account");

const USERNAME_FIELD_NAME = process.env.GHL_USERNAME_FIELD_NAME || "IG_username";
const BIO_FIELD_NAME = process.env.GHL_BIO_FIELD_NAME || "IG_bio";

(async () => {
  const locationId = process.env.GHL_LOCATION_ID;
  const pitToken = process.env.GHL_PIT_TOKEN;
  const mongoUri = process.env.MONGO_URI;

  if (!locationId || !pitToken || !mongoUri) {
    console.error("Missing GHL_LOCATION_ID, GHL_PIT_TOKEN, or MONGO_URI env var");
    process.exit(1);
  }

  console.log(`Fetching custom fields for location ${locationId}...`);
  const res = await fetch(
    `https://services.leadconnectorhq.com/locations/${locationId}/customFields`,
    {
      headers: {
        Authorization: `Bearer ${pitToken}`,
        Version: "2021-07-28",
        Accept: "application/json",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`LeadConnector error ${res.status}: ${body}`);
    process.exit(1);
  }

  const data = await res.json();
  const fields = data.customFields || data.fields || [];
  console.log(`Found ${fields.length} custom fields`);

  const usernameField = fields.find((f) => f.name === USERNAME_FIELD_NAME);
  const bioField = fields.find((f) => f.name === BIO_FIELD_NAME);

  if (!usernameField || !bioField) {
    console.error(
      `Could not find required custom fields. Looking for "${USERNAME_FIELD_NAME}" and "${BIO_FIELD_NAME}".`,
    );
    console.error("Available field names:", fields.map((f) => f.name).join(", "));
    process.exit(1);
  }

  console.log(`  ${USERNAME_FIELD_NAME} → ${usernameField.id}`);
  console.log(`  ${BIO_FIELD_NAME}      → ${bioField.id}`);

  await mongoose.connect(mongoUri);

  const account = await Account.findOne({ ghl: locationId });
  if (!account) {
    console.error(`No Account found with ghl=${locationId}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  account.ghl_pit_token = Account.encryptField(pitToken);
  account.ghl_ig_username_field_id = usernameField.id;
  account.ghl_ig_bio_field_id = bioField.id;
  await account.save();

  console.log(`Updated account ${account._id} (${account.name || "unnamed"})`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

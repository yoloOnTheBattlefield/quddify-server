/**
 * READ-ONLY simulation: pretends to be coachowenroddy@gmail.com (role=2) and
 * runs the same Mongo queries the refactored routes would run, to verify the
 * cross-account scoping works.
 *
 * Compares against:
 *   - what an admin (role=0/1) for the same data sees
 *   - what Owen would have seen with the OLD account_id-only filter
 *
 * Usage:
 *   MONGO_URI="mongodb+srv://...CRM" node scripts/verify-owen-roddy-access.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/User");
const AccountUser = require("../models/AccountUser");
const Client = require("../models/Client");
const Carousel = require("../models/Carousel");
const ClientImage = require("../models/ClientImage");
const {
  getOwnedClientIds,
  buildClientScopedFilter,
  buildClientCollectionFilter,
  loadOwnedClient,
  findOwnedDoc,
} = require("../utils/clientUserScope");

const TARGET_EMAIL = "coachowenroddy@gmail.com";

function makeReqFor(user, membership) {
  // Mock req shape used by the helpers: { user: { userId, role }, account: { _id } }
  return {
    user: { userId: user._id, role: membership.role },
    account: { _id: membership.account_id },
  };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.db.databaseName}\n`);

  const user = await User.findOne({ email: TARGET_EMAIL.toLowerCase() }).lean();
  if (!user) throw new Error(`User ${TARGET_EMAIL} not found`);
  const membership = await AccountUser.findOne({ user_id: user._id }).lean();
  if (!membership) throw new Error(`No AccountUser membership for ${TARGET_EMAIL}`);

  console.log(`User: ${user.email}  _id=${user._id}`);
  console.log(`Membership: account_id=${membership.account_id}  role=${membership.role}`);
  console.log();

  const req = makeReqFor(user, membership);

  // ── 1. clients list ───────────────────────────────────────────────────
  const clientFilter = await buildClientCollectionFilter(req);
  const clients = await Client.find(clientFilter).lean();
  console.log(`[GET /api/clients] role=${req.user.role} → ${clients.length} client(s)`);
  for (const c of clients) {
    console.log(`  - ${c.name}  _id=${c._id}  account_id=${c.account_id}`);
  }
  console.log();

  // ── 2. carousels list ─────────────────────────────────────────────────
  const carouselFilter = await buildClientScopedFilter(req);
  const carousels = carouselFilter
    ? await Carousel.find(carouselFilter).sort({ created_at: -1 }).limit(50).lean()
    : [];
  console.log(`[GET /api/carousels] → ${carousels.length} carousel(s)`);
  for (const c of carousels.slice(0, 5)) {
    console.log(`  - ${c.topic || "(no topic)"}  _id=${c._id}  status=${c.status}`);
  }
  if (carousels.length > 5) console.log(`  …and ${carousels.length - 5} more`);
  console.log();

  // ── 3. client-images list ─────────────────────────────────────────────
  const imageFilter = await buildClientScopedFilter(req);
  const imageCount = imageFilter ? await ClientImage.countDocuments(imageFilter) : 0;
  console.log(`[GET /api/client-images] → ${imageCount} image(s)`);
  console.log();

  // ── 4. ownership lookups ──────────────────────────────────────────────
  const ownedClientIds = await getOwnedClientIds(req);
  console.log(`getOwnedClientIds → [${ownedClientIds.map((i) => i.toString()).join(", ")}]`);

  if (clients.length > 0) {
    const c = clients[0];
    const owned = await loadOwnedClient(req, c._id);
    console.log(`loadOwnedClient(${c._id}) → ${owned ? "OK (" + owned.name + ")" : "NULL"}`);
  }

  if (carousels.length > 0) {
    // Reset cache so findOwnedDoc re-runs
    delete req._ownedClientIds;
    const c = await findOwnedDoc(Carousel, req, carousels[0]._id);
    console.log(`findOwnedDoc(Carousel, ${carousels[0]._id}) → ${c ? "OK" : "NULL"}`);
  }
  console.log();

  // ── 5. negative test: a carousel that does NOT belong to Owen ─────────
  // Find any carousel that belongs to a different client.
  const otherCarousel = await Carousel.findOne({
    client_id: { $nin: ownedClientIds },
  }).lean();
  if (otherCarousel) {
    delete req._ownedClientIds;
    const c = await findOwnedDoc(Carousel, req, otherCarousel._id);
    console.log(
      `[security] cross-client read: findOwnedDoc(${otherCarousel._id}) → ${c ? "FAIL (LEAK)" : "OK (blocked)"}`,
    );
  }

  // ── 6. compare to old behavior (account_id filter on Owen's account) ──
  console.log();
  console.log(`=== OLD account-id-only behavior (for comparison) ===`);
  const oldCarousels = await Carousel.countDocuments({ account_id: membership.account_id });
  const oldImages = await ClientImage.countDocuments({ account_id: membership.account_id });
  const oldClients = await Client.countDocuments({
    account_id: membership.account_id,
    user_id: user._id,
  });
  console.log(`  clients=${oldClients}  carousels=${oldCarousels}  images=${oldImages}`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});

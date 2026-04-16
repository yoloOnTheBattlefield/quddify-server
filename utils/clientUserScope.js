/**
 * Ownership helpers for the carousel-app data plane.
 *
 * Model:
 *   - `Client` is the only doc that carries `account_id` (the creator who
 *     owns the client). Every other carousel-app collection (Carousel,
 *     ClientImage, CarouselJob, Transcript, …) hangs off `Client` via
 *     `client_id` and is NOT account-scoped at query time.
 *   - "Admin user" (creator/owner of a CRM tenant): sees Clients where
 *     `Client.account_id == req.account._id`.
 *   - "Client user" (the person whose business the Client doc represents):
 *     sees Clients where `Client.user_id == req.user.userId`. Their own
 *     login lives in a dedicated isolated Account, which holds none of
 *     their carousel-app data — that data lives under the creator's
 *     account but is linked back via `Client.user_id`.
 *
 * Detection: a caller is treated as a "client user" iff any Client doc has
 * `user_id == req.user.userId`. We can NOT use `req.user.role` for this
 * because client users created via POST /api/clients are role=1 (owner of
 * their own isolated account). The presence of a Client→user link is the
 * authoritative signal.
 *
 * All read/write routes for the carousel-app data plane should resolve the
 * caller's owned `client_id` set with these helpers and scope queries by
 * `client_id ∈ <owned>` instead of `account_id`.
 */

const Client = require("../models/Client");

/**
 * Returns the array of Client._id values that the caller owns.
 *
 * Resolution rule:
 *   1. If any Client has `user_id == req.user.userId` → caller is a client
 *      user. Return all such Client._ids regardless of account_id.
 *   2. Otherwise → caller is an admin/creator. Return Client._ids in
 *      `req.account._id`.
 *
 * Cached on req for the duration of the request.
 */
async function getOwnedClientIds(req) {
  if (req._ownedClientIds) return req._ownedClientIds;

  // 1. Try the "client user" path first (admins always use the admin path
  //    even if they have a Client doc linked to them).
  if (req.user?.userId && req.user.role !== 0) {
    const asClientUser = await Client.find({ user_id: req.user.userId }, { _id: 1 }).lean();
    if (asClientUser.length > 0) {
      req._ownedClientIds = asClientUser.map((c) => c._id);
      req._ownershipMode = "client_user";
      return req._ownedClientIds;
    }
  }

  // 2. Admin/creator path — include clients in the admin's account AND any
  //    Client doc linked to the admin's own user_id (e.g. created by another
  //    account for them) so they appear in the client picker too.
  if (req.account?._id) {
    const conditions = [{ account_id: req.account._id }];
    if (req.user?.userId) {
      conditions.push({ user_id: req.user.userId });
    }
    const asAdmin = await Client.find({ $or: conditions }, { _id: 1 }).lean();
    req._ownedClientIds = asAdmin.map((c) => c._id);
    req._ownershipMode = "admin";
    return req._ownedClientIds;
  }

  req._ownedClientIds = [];
  req._ownershipMode = "none";
  return req._ownedClientIds;
}

/**
 * Returns a Mongo filter to match Client docs the caller owns.
 * Used by routes that operate directly on the Client collection.
 */
async function ownershipFilter(req) {
  // Trigger resolution so req._ownershipMode is set.
  await getOwnedClientIds(req);
  if (req._ownershipMode === "client_user") {
    return { user_id: req.user.userId };
  }
  // For admins, include their account's clients + any Client linked to them.
  const conditions = [{ account_id: req.account._id }];
  if (req.user?.userId) {
    conditions.push({ user_id: req.user.userId });
  }
  return { $or: conditions };
}

/**
 * Build a Mongo filter for collections keyed by client_id (Carousel,
 * ClientImage, CarouselJob, Transcript, …).
 *
 * Returns null when the caller owns zero clients — caller should treat as
 * an empty result set.
 */
async function buildClientScopedFilter(req) {
  const ids = await getOwnedClientIds(req);
  if (ids.length === 0) return null;
  return { client_id: { $in: ids } };
}

/**
 * Build a Mongo filter for the Client collection itself.
 */
async function buildClientCollectionFilter(req) {
  return ownershipFilter(req);
}

/**
 * Verify that the caller owns the given clientId. Returns the Client doc
 * (with full fields, NOT lean) on success, or null if the caller does not
 * own it. Use this on POST/PATCH/DELETE routes that take a client_id in
 * the request body or URL.
 */
async function loadOwnedClient(req, clientId) {
  if (!clientId) return null;
  const filter = await ownershipFilter(req);
  return Client.findOne({ _id: clientId, ...filter });
}

/**
 * Verify the caller owns a specific data doc (Carousel, ClientImage, …) by
 * its _id. Returns the doc on success, null otherwise.
 *
 * @param Model — Mongoose model with a `client_id` field
 * @param docId — _id of the doc
 */
async function findOwnedDoc(Model, req, docId) {
  const ids = await getOwnedClientIds(req);
  if (ids.length === 0) return null;
  return Model.findOne({ _id: docId, client_id: { $in: ids } });
}

module.exports = {
  getOwnedClientIds,
  buildClientScopedFilter,
  buildClientCollectionFilter,
  loadOwnedClient,
  findOwnedDoc,
};

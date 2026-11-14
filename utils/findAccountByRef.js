const mongoose = require("mongoose");
const Account = require("../models/Account");

/**
 * Resolve an account from a reference that arrives on a public URL
 * (?account=..., utm_source, Stripe metadata).
 *
 * New URLs carry the Account _id. URLs registered before Go High Level was
 * removed carry the account's old `ghl` location id, which is still stored on
 * the account as a legacy lookup key so those webhooks keep resolving.
 */
async function findAccountByRef(ref, { lean = false } = {}) {
  if (!ref || typeof ref !== "string") return null;
  const query = mongoose.isValidObjectId(ref) && String(new mongoose.Types.ObjectId(ref)) === ref
    ? Account.findById(ref)
    : Account.findOne({ ghl: ref });
  return lean ? query.lean() : query;
}

module.exports = { findAccountByRef };

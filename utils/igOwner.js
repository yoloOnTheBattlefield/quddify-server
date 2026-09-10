const Account = require("../models/Account");
const OutboundAccount = require("../models/OutboundAccount");
const { decrypt } = require("./crypto");

/**
 * Shape of a Zernio connection, decrypted and ready to send with.
 * Null unless the account has an active Zernio connection for this IG account.
 */
function zernioConnection(account, igUserId) {
  const z = account?.zernio;
  if (!z?.enabled || !z.api_key || !z.zernio_account_id) return null;
  if (igUserId && z.ig_user_id !== igUserId) return null;

  return {
    apiKey: decrypt(z.api_key),
    zernioAccountId: z.zernio_account_id,
    profileId: z.profile_id || null,
    ig_user_id: z.ig_user_id || null,
  };
}

/**
 * Resolve which of our accounts owns a given IG business user ID.
 *
 * An account can reach Instagram through our own Meta app (`ig_oauth`) or
 * through Zernio, so both are checked; `provider` says which path outbound
 * sends must take. Meta wins when an account somehow has both, unless the
 * Zernio connection is the one bound to this IG user ID.
 *
 * Returns null when the ID belongs to nobody we know.
 */
async function findIgOwner(igUserId) {
  const account = await Account.findOne({
    $or: [{ "ig_oauth.ig_user_id": igUserId }, { "zernio.ig_user_id": igUserId }],
  });

  if (account) {
    // zernioConnection already requires an enabled connection bound to this
    // exact IG user ID, so a non-null result means Zernio owns this account.
    const zernio = zernioConnection(account, igUserId);

    return {
      account_id: account._id,
      outbound_account_id: null,
      pageAccessToken: decrypt(account.ig_oauth?.page_access_token) || null,
      provider: zernio ? "zernio" : "meta",
      zernio,
    };
  }

  const outbound = await OutboundAccount.findOne({ "ig_oauth.ig_user_id": igUserId });
  if (outbound) {
    return {
      account_id: outbound.account_id,
      outbound_account_id: outbound._id,
      pageAccessToken: decrypt(outbound.ig_oauth?.page_access_token) || null,
      provider: "meta",
      zernio: null,
    };
  }

  return null;
}

module.exports = { findIgOwner, zernioConnection };

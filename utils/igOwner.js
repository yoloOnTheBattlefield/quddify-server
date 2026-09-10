const Account = require("../models/Account");
const OutboundAccount = require("../models/OutboundAccount");
const { decrypt } = require("./crypto");

// Resolve which of our accounts owns a given IG business user ID.
// Checks the main Account first, then OutboundAccount (sender accounts).
// Returns null when the ID belongs to nobody we know.
async function findIgOwner(igUserId) {
  const account = await Account.findOne({ "ig_oauth.ig_user_id": igUserId });
  if (account) {
    return {
      account_id: account._id,
      outbound_account_id: null,
      pageAccessToken: decrypt(account.ig_oauth?.page_access_token) || null,
    };
  }

  const outbound = await OutboundAccount.findOne({ "ig_oauth.ig_user_id": igUserId });
  if (outbound) {
    return {
      account_id: outbound.account_id,
      outbound_account_id: outbound._id,
      pageAccessToken: decrypt(outbound.ig_oauth?.page_access_token) || null,
    };
  }

  return null;
}

module.exports = { findIgOwner };

const express = require("express");
const router = express.Router();
const Account = require("../models/Account");
const OutboundAccount = require("../models/OutboundAccount");

const IG_APP_ID = process.env.IG_APP_ID;
const IG_APP_SECRET = process.env.IG_APP_SECRET;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const IG_REDIRECT_URI = process.env.IG_REDIRECT_URI;

// ─── Shared: exchange code for token + fetch IG profile ─────────────────────
async function exchangeCodeForToken(code) {
  // 1. Exchange code for access token via Facebook Graph API
  const tokenUrl =
    `https://graph.facebook.com/v21.0/oauth/access_token` +
    `?client_id=${IG_APP_ID}` +
    `&client_secret=${FB_APP_SECRET || IG_APP_SECRET}` +
    `&redirect_uri=${encodeURIComponent(IG_REDIRECT_URI)}` +
    `&code=${code}`;

  const tokenResponse = await fetch(tokenUrl);
  const tokenData = await tokenResponse.json();
  console.log("[ig-oauth] Token exchange response:", JSON.stringify(tokenData));

  if (tokenData.error) {
    throw new Error(tokenData.error.message || "Token exchange failed");
  }

  const accessToken = tokenData.access_token;

  // 2. Get the user's Instagram Business account via their Facebook pages
  const pagesResponse = await fetch(
    `https://graph.facebook.com/v21.0/me/accounts?access_token=${accessToken}`,
  );
  const pagesData = await pagesResponse.json();
  console.log("[ig-oauth] Pages response:", JSON.stringify(pagesData));

  let igUserId = null;
  let igUsername = null;
  let pageId = null;
  let pageAccessToken = null;

  // Find the Instagram account linked to any of the user's pages
  for (const page of pagesData.data || []) {
    const igResponse = await fetch(
      `https://graph.facebook.com/v21.0/${page.id}?fields=instagram_business_account&access_token=${accessToken}`,
    );
    const igData = await igResponse.json();

    if (igData.instagram_business_account) {
      igUserId = igData.instagram_business_account.id;
      pageId = page.id;
      pageAccessToken = page.access_token;

      // Get IG username
      const profileResponse = await fetch(
        `https://graph.facebook.com/v21.0/${igUserId}?fields=username&access_token=${accessToken}`,
      );
      const profileData = await profileResponse.json();
      igUsername = profileData.username || null;
      console.log(`[ig-oauth] Found IG account: @${igUsername} (${igUserId}) on page ${pageId}`);
      break;
    }
  }

  if (!igUserId) {
    throw new Error("No Instagram Business account found linked to your Facebook pages");
  }

  // 3. Subscribe the page to the app's webhooks (required for DM webhooks to fire)
  const subscribeResponse = await fetch(
    `https://graph.facebook.com/v21.0/${pageId}/subscribed_apps`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscribed_fields: "messages",
        access_token: pageAccessToken,
      }),
    },
  );
  const subscribeData = await subscribeResponse.json();
  console.log("[ig-oauth] Page webhook subscription:", JSON.stringify(subscribeData));

  return { accessToken, igUserId, igUsername, pageId, pageAccessToken };
}

// ─── GET /api/instagram/auth-url ─────────────────────────────────────────────
// Query params: ?outbound_account_id=xxx (optional, for outbound account OAuth)
router.get("/auth-url", (req, res) => {
  if (!IG_APP_ID || !IG_REDIRECT_URI) {
    return res.status(500).json({ error: "Instagram OAuth not configured" });
  }

  const scopes = "instagram_basic,instagram_manage_messages,pages_show_list,pages_read_engagement,pages_messaging";
  const outboundId = req.query.outbound_account_id;
  const state = outboundId ? `oa:${outboundId}` : `acct:${req.account._id}`;

  const url =
    `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${IG_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(IG_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&response_type=code` +
    `&state=${state}`;

  res.json({ url });
});

// ─── POST /api/instagram/callback — save to main account ────────────────────
router.post("/callback", async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: "Missing authorization code" });
  }

  try {
    const { accessToken, igUserId, igUsername } = await exchangeCodeForToken(code);

    await Account.findByIdAndUpdate(req.account._id, {
      $set: {
        "ig_oauth.access_token": accessToken,
        "ig_oauth.ig_user_id": igUserId,
        "ig_oauth.ig_username": igUsername,
        "ig_oauth.connected_at": new Date(),
      },
    });

    console.log(`[ig-oauth] Connected @${igUsername} (${igUserId}) to account ${req.account._id}`);
    res.json({ success: true, ig_username: igUsername, ig_user_id: igUserId });
  } catch (err) {
    console.error("[ig-oauth] Callback error:", err);
    res.status(400).json({ error: err.message || "Failed to complete Instagram authorization" });
  }
});

// ─── DELETE /api/instagram/disconnect — remove main account OAuth ────────────
router.delete("/disconnect", async (req, res) => {
  try {
    await Account.findByIdAndUpdate(req.account._id, {
      $set: {
        "ig_oauth.access_token": null,
        "ig_oauth.ig_user_id": null,
        "ig_oauth.ig_username": null,
        "ig_oauth.connected_at": null,
      },
    });

    console.log(`[ig-oauth] Disconnected Instagram from account ${req.account._id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[ig-oauth] Disconnect error:", err);
    res.status(500).json({ error: "Failed to disconnect Instagram" });
  }
});

// ─── POST /api/instagram/outbound/:id/callback — save to outbound account ───
router.post("/outbound/:id/callback", async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: "Missing authorization code" });
  }

  try {
    const outboundAccount = await OutboundAccount.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!outboundAccount) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    const { accessToken, igUserId, igUsername } = await exchangeCodeForToken(code);

    await OutboundAccount.findByIdAndUpdate(outboundAccount._id, {
      $set: {
        "ig_oauth.access_token": accessToken,
        "ig_oauth.ig_user_id": igUserId,
        "ig_oauth.ig_username": igUsername,
        "ig_oauth.connected_at": new Date(),
      },
    });

    console.log(
      `[ig-oauth] Connected @${igUsername} to outbound account ${outboundAccount._id} (${outboundAccount.username})`,
    );
    res.json({ success: true, ig_username: igUsername, ig_user_id: igUserId });
  } catch (err) {
    console.error("[ig-oauth] Outbound callback error:", err);
    res.status(400).json({ error: err.message || "Failed to complete Instagram authorization" });
  }
});

// ─── DELETE /api/instagram/outbound/:id/disconnect — remove outbound OAuth ───
router.delete("/outbound/:id/disconnect", async (req, res) => {
  try {
    const result = await OutboundAccount.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      {
        $set: {
          "ig_oauth.access_token": null,
          "ig_oauth.ig_user_id": null,
          "ig_oauth.ig_username": null,
          "ig_oauth.connected_at": null,
        },
      },
    );

    if (!result) {
      return res.status(404).json({ error: "Outbound account not found" });
    }

    console.log(`[ig-oauth] Disconnected Instagram from outbound account ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[ig-oauth] Outbound disconnect error:", err);
    res.status(500).json({ error: "Failed to disconnect Instagram" });
  }
});

module.exports = router;

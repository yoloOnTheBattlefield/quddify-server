const express = require("express");
const router = express.Router();
const Account = require("../models/Account");
const OutboundAccount = require("../models/OutboundAccount");

const IG_APP_ID = process.env.IG_APP_ID;
const IG_APP_SECRET = process.env.IG_APP_SECRET;
const IG_REDIRECT_URI = process.env.IG_REDIRECT_URI;

// ─── Shared: exchange code for long-lived token + fetch profile ─────────────
async function exchangeCodeForToken(code) {
  // 1. Exchange code for short-lived token
  const tokenResponse = await fetch(
    "https://api.instagram.com/oauth/access_token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: IG_APP_ID,
        client_secret: IG_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: IG_REDIRECT_URI,
        code,
      }),
    },
  );

  const tokenData = await tokenResponse.json();
  if (tokenData.error_message || tokenData.error) {
    throw new Error(
      tokenData.error_message || tokenData.error?.message || "Token exchange failed",
    );
  }

  const shortLivedToken = tokenData.access_token;
  const igUserId = String(tokenData.user_id);

  // 2. Exchange for long-lived token (60 days)
  const longTokenResponse = await fetch(
    `https://graph.instagram.com/access_token` +
      `?grant_type=ig_exchange_token` +
      `&client_secret=${IG_APP_SECRET}` +
      `&access_token=${shortLivedToken}`,
  );

  const longTokenData = await longTokenResponse.json();
  const accessToken = longTokenData.access_token || shortLivedToken;

  // 3. Fetch IG username
  const profileResponse = await fetch(
    `https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=${accessToken}`,
  );
  const profileData = await profileResponse.json();
  const igUsername = profileData.username || null;

  return { accessToken, igUserId, igUsername };
}

// ─── GET /api/instagram/auth-url ─────────────────────────────────────────────
// Query params: ?outbound_account_id=xxx (optional, for outbound account OAuth)
router.get("/auth-url", (req, res) => {
  if (!IG_APP_ID || !IG_REDIRECT_URI) {
    return res.status(500).json({ error: "Instagram OAuth not configured" });
  }

  const scopes = "instagram_business_basic,instagram_business_manage_messages";
  const outboundId = req.query.outbound_account_id;
  const state = outboundId ? `oa:${outboundId}` : `acct:${req.account._id}`;

  const url =
    `https://www.instagram.com/oauth/authorize` +
    `?enable_fb_login=0` +
    `&force_authentication=1` +
    `&client_id=${IG_APP_ID}` +
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

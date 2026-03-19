const logger = require("../utils/logger").child({ module: "instagram-oauth" });
const express = require("express");
const router = express.Router();
const Account = require("../models/Account");
const OutboundAccount = require("../models/OutboundAccount");
const { encrypt, decrypt } = require("../utils/crypto");

const IG_APP_ID = process.env.IG_APP_ID;
const IG_APP_SECRET = process.env.IG_APP_SECRET;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const IG_REDIRECT_URI = process.env.IG_REDIRECT_URI;

// ─── Shared: exchange code for token + fetch IG profile ─────────────────────
// targetUsername: if provided, selects the IG account matching this username
async function exchangeCodeForToken(code, targetUsername = null) {
  // 1. Exchange code for access token via Facebook Graph API
  const tokenUrl =
    `https://graph.facebook.com/v21.0/oauth/access_token` +
    `?client_id=${IG_APP_ID}` +
    `&client_secret=${FB_APP_SECRET || IG_APP_SECRET}` +
    `&redirect_uri=${encodeURIComponent(IG_REDIRECT_URI)}` +
    `&code=${code}`;

  const tokenResponse = await fetch(tokenUrl);
  const tokenData = await tokenResponse.json();
  logger.info("[ig-oauth] Token exchange response:", JSON.stringify(tokenData));

  if (tokenData.error) {
    throw new Error(tokenData.error.message || "Token exchange failed");
  }

  const accessToken = tokenData.access_token;

  // 2. Discover ALL Instagram Business accounts across the user's Facebook pages
  const pagesResponse = await fetch(
    `https://graph.facebook.com/v21.0/me/accounts?access_token=${accessToken}`,
  );
  const pagesData = await pagesResponse.json();
  logger.info("[ig-oauth] Pages response:", JSON.stringify(pagesData));

  const allIgAccounts = [];

  for (const page of pagesData.data || []) {
    const igResponse = await fetch(
      `https://graph.facebook.com/v21.0/${page.id}?fields=instagram_business_account&access_token=${accessToken}`,
    );
    const igData = await igResponse.json();

    if (igData.instagram_business_account) {
      const igId = igData.instagram_business_account.id;
      const profileResponse = await fetch(
        `https://graph.facebook.com/v21.0/${igId}?fields=username&access_token=${accessToken}`,
      );
      const profileData = await profileResponse.json();
      const username = profileData.username || null;

      logger.info(`[ig-oauth] Found IG account: @${username} (${igId}) on page ${page.id}`);
      allIgAccounts.push({
        igUserId: igId,
        igUsername: username,
        pageId: page.id,
        pageAccessToken: page.access_token,
      });
    }
  }

  if (allIgAccounts.length === 0) {
    throw new Error("No Instagram Business account found linked to your Facebook pages");
  }

  logger.info(`[ig-oauth] Found ${allIgAccounts.length} IG account(s): ${allIgAccounts.map(a => `@${a.igUsername}`).join(", ")}`);

  // 3. Select the right IG account
  let selected;
  if (targetUsername) {
    const target = targetUsername.toLowerCase().replace(/^@/, "");
    selected = allIgAccounts.find(a => a.igUsername?.toLowerCase() === target);
    if (!selected) {
      const available = allIgAccounts.map(a => `@${a.igUsername}`).join(", ");
      throw new Error(`No IG account matching @${targetUsername} found. Available: ${available}`);
    }
    logger.info(`[ig-oauth] Matched target @${targetUsername} → @${selected.igUsername} (${selected.igUserId})`);
  } else {
    selected = allIgAccounts[0];
  }

  // 4. Subscribe the page to the app's webhooks (required for DM webhooks to fire)
  const subscribeResponse = await fetch(
    `https://graph.facebook.com/v21.0/${selected.pageId}/subscribed_apps`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscribed_fields: "messages",
        access_token: selected.pageAccessToken,
      }),
    },
  );
  const subscribeData = await subscribeResponse.json();
  logger.info("[ig-oauth] Page webhook subscription:", JSON.stringify(subscribeData));

  return { accessToken, ...selected };
}

// ─── GET /api/instagram/auth-url ─────────────────────────────────────────────
// Query params: ?outbound_account_id=xxx (optional, for outbound account OAuth)
router.get("/auth-url", (req, res) => {
  if (!IG_APP_ID || !IG_REDIRECT_URI) {
    return res.status(500).json({ error: "Instagram OAuth not configured" });
  }

  const scopes = "instagram_basic,instagram_manage_messages,pages_show_list,pages_read_engagement,pages_messaging,pages_manage_metadata";
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
    const { accessToken, igUserId, igUsername, pageId, pageAccessToken } = await exchangeCodeForToken(code);

    await Account.findByIdAndUpdate(req.account._id, {
      $set: {
        "ig_oauth.access_token": encrypt(accessToken),
        "ig_oauth.page_access_token": encrypt(pageAccessToken),
        "ig_oauth.page_id": pageId,
        "ig_oauth.ig_user_id": igUserId,
        "ig_oauth.ig_username": igUsername,
        "ig_oauth.connected_at": new Date(),
      },
    });

    logger.info(`[ig-oauth] Connected @${igUsername} (${igUserId}) to account ${req.account._id}`);
    res.json({ success: true, ig_username: igUsername, ig_user_id: igUserId });
  } catch (err) {
    logger.error("[ig-oauth] Callback error:", err);
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

    logger.info(`[ig-oauth] Disconnected Instagram from account ${req.account._id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error("[ig-oauth] Disconnect error:", err);
    res.status(500).json({ error: "Failed to disconnect Instagram" });
  }
});

// ─── GET /api/instagram/client/:clientId/auth-url — OAuth URL for a client ───
router.get("/client/:clientId/auth-url", async (req, res) => {
  if (!IG_APP_ID || !IG_REDIRECT_URI) {
    return res.status(500).json({ error: "Instagram OAuth not configured" });
  }

  const Client = require("../models/Client");
  const client = await Client.findOne({ _id: req.params.clientId, account_id: req.account._id });
  if (!client) return res.status(404).json({ error: "Client not found" });

  const scopes = "instagram_basic,instagram_manage_messages,instagram_content_publish,pages_show_list,pages_read_engagement,pages_messaging,pages_manage_metadata";
  const state = `client:${client._id}`;

  const url =
    `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${IG_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(IG_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&response_type=code` +
    `&state=${state}`;

  res.json({ url });
});

// ─── POST /api/instagram/client/:clientId/callback — save OAuth to client ────
router.post("/client/:clientId/callback", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Missing authorization code" });

  const Client = require("../models/Client");
  const client = await Client.findOne({ _id: req.params.clientId, account_id: req.account._id });
  if (!client) return res.status(404).json({ error: "Client not found" });

  try {
    const targetUsername = client.ig_username || null;
    const { accessToken, igUserId, igUsername, pageId, pageAccessToken } = await exchangeCodeForToken(code, targetUsername);

    await Client.findByIdAndUpdate(client._id, {
      $set: {
        "ig_oauth.access_token": encrypt(accessToken),
        "ig_oauth.page_access_token": encrypt(pageAccessToken),
        "ig_oauth.page_id": pageId,
        "ig_oauth.ig_user_id": igUserId,
        "ig_oauth.ig_username": igUsername,
        "ig_oauth.connected_at": new Date(),
        ig_username: igUsername,
      },
    });

    logger.info(`[ig-oauth] Connected @${igUsername} (${igUserId}) to client ${client._id} (${client.name})`);
    res.json({ success: true, ig_username: igUsername, ig_user_id: igUserId });
  } catch (err) {
    logger.error("[ig-oauth] Client callback error:", err);
    res.status(400).json({ error: err.message || "Failed to complete Instagram authorization" });
  }
});

// ─── DELETE /api/instagram/client/:clientId/disconnect — remove client OAuth ─
router.delete("/client/:clientId/disconnect", async (req, res) => {
  const Client = require("../models/Client");
  try {
    const result = await Client.findOneAndUpdate(
      { _id: req.params.clientId, account_id: req.account._id },
      {
        $set: {
          "ig_oauth.access_token": null,
          "ig_oauth.page_access_token": null,
          "ig_oauth.page_id": null,
          "ig_oauth.ig_user_id": null,
          "ig_oauth.ig_username": null,
          "ig_oauth.connected_at": null,
        },
      },
    );
    if (!result) return res.status(404).json({ error: "Client not found" });

    logger.info(`[ig-oauth] Disconnected Instagram from client ${req.params.clientId}`);
    res.json({ success: true });
  } catch (err) {
    logger.error("[ig-oauth] Client disconnect error:", err);
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

    const { accessToken, igUserId, igUsername, pageId, pageAccessToken } = await exchangeCodeForToken(code, outboundAccount.username);

    await OutboundAccount.findByIdAndUpdate(outboundAccount._id, {
      $set: {
        "ig_oauth.access_token": encrypt(accessToken),
        "ig_oauth.page_access_token": encrypt(pageAccessToken),
        "ig_oauth.page_id": pageId,
        "ig_oauth.ig_user_id": igUserId,
        "ig_oauth.ig_username": igUsername,
        "ig_oauth.connected_at": new Date(),
      },
    });

    logger.info(
      `[ig-oauth] Connected @${igUsername} to outbound account ${outboundAccount._id} (${outboundAccount.username})`,
    );
    res.json({ success: true, ig_username: igUsername, ig_user_id: igUserId });
  } catch (err) {
    logger.error("[ig-oauth] Outbound callback error:", err);
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

    logger.info(`[ig-oauth] Disconnected Instagram from outbound account ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error("[ig-oauth] Outbound disconnect error:", err);
    res.status(500).json({ error: "Failed to disconnect Instagram" });
  }
});

// ─── GET /api/instagram/reels/monthly/:clientId — reels this month for one client ──
router.get("/reels/monthly/:clientId", async (req, res) => {
  const Client = require("../models/Client");

  try {
    const client = await Client.findOne({
      _id: req.params.clientId,
      account_id: req.account._id,
    }).select("name ig_username ig_oauth.page_access_token ig_oauth.ig_user_id ig_oauth.ig_username");

    if (!client) return res.status(404).json({ error: "Client not found" });

    if (!client.ig_oauth?.page_access_token || !client.ig_oauth?.ig_user_id) {
      return res.status(400).json({ error: "Instagram not connected for this client" });
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const sinceUnix = Math.floor(startOfMonth.getTime() / 1000);

    const token = decrypt(client.ig_oauth.page_access_token);
    const igUserId = client.ig_oauth.ig_user_id;
    const igUsername = client.ig_oauth.ig_username || client.ig_username;

    const fields = "id,media_type,media_product_type,timestamp,permalink";
    let reels = [];
    let url = `https://graph.facebook.com/v21.0/${igUserId}/media?fields=${fields}&since=${sinceUnix}&limit=100&access_token=${token}`;

    while (url) {
      const resp = await fetch(url);
      const data = await resp.json();

      if (data.error) {
        logger.warn(`[reels] IG API error for client ${client._id}: ${data.error.message}`);
        return res.status(502).json({ error: data.error.message || "Instagram API error" });
      }

      for (const item of data.data || []) {
        if (item.media_product_type === "REELS") {
          reels.push({ id: item.id, timestamp: item.timestamp, permalink: item.permalink });
        }
      }

      url = data.paging?.next || null;
    }

    const monthLabel = startOfMonth.toLocaleString("en-US", { month: "long", year: "numeric" });
    res.json({
      month: monthLabel,
      since: startOfMonth.toISOString(),
      ig_username: igUsername,
      count: reels.length,
      reels,
    });
  } catch (err) {
    logger.error("[reels] Monthly reels error:", err);
    res.status(500).json({ error: "Failed to fetch monthly reels" });
  }
});

module.exports = router;

const express = require("express");
const router = express.Router();
const { google } = require("googleapis");
const Client = require("../models/Client");
const logger = require("../utils/logger").child({ module: "google-drive" });

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

// GET /api/google-drive/auth-url?client_id=xxx — get OAuth URL for connecting Google Drive
router.get("/auth-url", async (req, res) => {
  try {
    const { client_id } = req.query;
    if (!client_id) return res.status(400).json({ error: "client_id required" });

    const client = await Client.findOne({ _id: client_id, account_id: req.account._id });
    if (!client) return res.status(404).json({ error: "Client not found" });

    const oauth2Client = getOAuthClient();
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/drive.readonly"],
      state: client_id, // Pass client_id through OAuth state
      prompt: "consent",
    });

    res.json({ url });
  } catch (err) {
    logger.error("Failed to generate auth URL:", err);
    res.status(500).json({ error: "Failed to generate auth URL" });
  }
});

// GET /api/google-drive/callback — OAuth callback
router.get("/callback", async (req, res) => {
  try {
    const { code, state: clientId } = req.query;
    if (!code) return res.status(400).json({ error: "No auth code" });

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    // Store refresh token on the client
    if (clientId) {
      await Client.findByIdAndUpdate(clientId, {
        $set: { google_drive_sync_token: tokens.refresh_token || tokens.access_token },
      });
    }

    // Redirect back to frontend client detail page
    res.redirect(`http://localhost:5174/clients/${clientId}/images`);
  } catch (err) {
    logger.error("Google Drive callback failed:", err);
    res.status(500).json({ error: "OAuth callback failed" });
  }
});

// POST /api/google-drive/sync — trigger sync for a client
router.post("/sync", async (req, res) => {
  try {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: "client_id required" });

    const client = await Client.findOne({ _id: client_id, account_id: req.account._id });
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (!client.google_drive_folder_id) {
      return res.status(400).json({ error: "No Google Drive folder configured. Set google_drive_folder_id first." });
    }
    if (!client.google_drive_sync_token) {
      return res.status(400).json({ error: "Google Drive not connected. Authorize first." });
    }

    // Get fresh access token from refresh token
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({ refresh_token: client.google_drive_sync_token });
    const { credentials } = await oauth2Client.refreshAccessToken();

    const { syncClientImages } = require("../services/carousel/googleDriveSync");

    // Run sync in background
    syncClientImages(client._id, credentials.access_token).catch((err) => {
      logger.error(`Sync failed for client ${client.name}:`, err);
    });

    res.json({ message: "Sync started", client_id: client._id });
  } catch (err) {
    logger.error("Sync trigger failed:", err);
    res.status(500).json({ error: "Failed to start sync" });
  }
});

module.exports = router;

const { google } = require("googleapis");
const sharp = require("sharp");
const { upload } = require("../storageService");
const Client = require("../../models/Client");
const ClientImage = require("../../models/ClientImage");
const { tagImage } = require("./imageTagging");
const logger = require("../../utils/logger").child({ module: "googleDriveSync" });
const mongoose = require("mongoose");

// For MVP, use a service account or OAuth tokens stored per account
// This creates an OAuth2 client - the tokens should be stored on the Client model
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

/**
 * Sync all images from a client's Google Drive folder.
 * Downloads each image, uploads to S3, creates a ClientImage record, and queues tagging.
 */
async function syncClientImages(clientId, accessToken) {
  const client = await Client.findById(clientId);
  if (!client) throw new Error(`Client ${clientId} not found`);
  if (!client.google_drive_folder_id) throw new Error("No Google Drive folder configured");

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken });

  const drive = google.drive({ version: "v3", auth: oauth2Client });

  let pageToken = null;
  let totalImported = 0;
  const imageIdsToTag = [];

  do {
    const res = await drive.files.list({
      q: `'${client.google_drive_folder_id}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: "files(id, name, mimeType, size, imageMediaMetadata), nextPageToken",
      pageSize: 100,
      pageToken: pageToken || undefined,
    });

    for (const file of res.data.files || []) {
      // Skip if already imported
      const exists = await ClientImage.findOne({
        client_id: client._id,
        google_drive_file_id: file.id,
      });
      if (exists) continue;

      try {
        // Download file
        const downloadRes = await drive.files.get(
          { fileId: file.id, alt: "media" },
          { responseType: "arraybuffer" },
        );
        const buffer = Buffer.from(downloadRes.data);

        // Get image dimensions with sharp
        const metadata = await sharp(buffer).metadata();
        const width = metadata.width || 0;
        const height = metadata.height || 0;

        // Generate thumbnail (400px wide)
        const thumbnailBuffer = await sharp(buffer)
          .resize(400, null, { withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();

        // Upload original and thumbnail to S3
        const imageId = new mongoose.Types.ObjectId();
        const ext = file.mimeType === "image/png" ? "png" : "jpg";
        const originalKey = `${client.account_id}/${client._id}/images/originals/${imageId}.${ext}`;
        const thumbnailKey = `${client.account_id}/${client._id}/images/thumbnails/${imageId}.webp`;

        await upload(originalKey, buffer, file.mimeType);
        await upload(thumbnailKey, thumbnailBuffer, "image/webp");

        // Create ClientImage record
        const image = await ClientImage.create({
          _id: imageId,
          client_id: client._id,
          account_id: client.account_id,
          storage_key: originalKey,
          thumbnail_key: thumbnailKey,
          original_filename: file.name,
          mime_type: file.mimeType,
          width,
          height,
          file_size: file.size ? Number(file.size) : buffer.length,
          aspect_ratio: width && height ? width / height : 1,
          is_portrait: height > width,
          status: "processing",
          source: "google_drive",
          google_drive_file_id: file.id,
          total_uses: 0,
          used_in_carousels: [],
        });

        imageIdsToTag.push(image._id.toString());
        totalImported++;
        logger.info(`Imported ${file.name} for client ${client.name}`);
      } catch (err) {
        logger.error(`Failed to import ${file.name}:`, err);
      }
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  logger.info(`Sync complete for ${client.name}: ${totalImported} new images imported`);

  // Tag images in background (don't await - let them process)
  if (imageIdsToTag.length > 0) {
    const { tagImageBatch } = require("./imageTagging");
    tagImageBatch(imageIdsToTag, 3).catch((err) => {
      logger.error("Batch tagging failed:", err);
    });
  }

  return { imported: totalImported, queued_for_tagging: imageIdsToTag.length };
}

module.exports = { syncClientImages };

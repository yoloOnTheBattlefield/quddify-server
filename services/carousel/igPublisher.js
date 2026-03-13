const Account = require("../../models/Account");
const Client = require("../../models/Client");
const Carousel = require("../../models/Carousel");
const { decrypt } = require("../../utils/crypto");
const logger = require("../../utils/logger").child({ module: "ig-publisher" });

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

/**
 * Publish a carousel to Instagram via the Graph API.
 *
 * Instagram carousel publishing flow:
 * 1. Create child containers for each slide image
 * 2. Create a carousel container referencing all children
 * 3. Publish the carousel container
 */
async function publishToInstagram({ carouselId, accountId }) {
  const carousel = await Carousel.findById(carouselId).lean();
  if (!carousel) throw new Error("Carousel not found");

  // Try client-level ig_oauth first, fall back to account-level
  let oauthSource = null;
  if (carousel.client_id) {
    const client = await Client.findById(carousel.client_id).lean();
    if (client?.ig_oauth?.access_token) {
      oauthSource = client.ig_oauth;
      logger.info(`[ig-publish] Using client-level IG OAuth for client ${client.name}`);
    }
  }
  if (!oauthSource) {
    const account = await Account.findById(accountId).lean();
    if (account?.ig_oauth?.access_token) {
      oauthSource = account.ig_oauth;
      logger.info(`[ig-publish] Using account-level IG OAuth`);
    }
  }
  if (!oauthSource) {
    throw new Error("Instagram not connected. Connect via client settings first.");
  }

  const pageAccessToken = decrypt(oauthSource.page_access_token);
  const igUserId = oauthSource.ig_user_id;

  if (!pageAccessToken || !igUserId) {
    throw new Error("Instagram OAuth incomplete — missing page token or IG user ID");
  }
  if (carousel.status !== "ready") throw new Error("Carousel is not ready for publishing");
  if (carousel.posted_to_ig) throw new Error("Carousel already posted to Instagram");

  const slides = carousel.slides || [];
  if (slides.length < 2) throw new Error("Instagram carousels require at least 2 slides");
  if (slides.length > 10) throw new Error("Instagram carousels support max 10 slides");

  // Resolve public URLs for each slide's rendered image
  const baseUrl = process.env.S3_PUBLIC_URL || process.env.BASE_URL || "";
  const imageUrls = slides.map((slide) => {
    const key = slide.rendered_key || slide.image_key;
    if (!key) throw new Error(`Slide ${slide.position} has no rendered image`);
    if (key.startsWith("http")) return key;
    return `${baseUrl}/${key}`;
  });

  logger.info(`[ig-publish] Publishing carousel ${carouselId} with ${imageUrls.length} slides to @${oauthSource.ig_username}`);

  // Step 1: Create child containers for each image
  const childIds = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const resp = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: imageUrls[i],
        is_carousel_item: true,
        access_token: pageAccessToken,
      }),
    });
    const data = await resp.json();
    if (data.error) {
      throw new Error(`Failed to create slide ${i + 1} container: ${data.error.message}`);
    }
    childIds.push(data.id);
    logger.info(`[ig-publish] Created child container ${i + 1}/${imageUrls.length}: ${data.id}`);
  }

  // Step 2: Create carousel container
  const carouselResp = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      media_type: "CAROUSEL",
      children: childIds.join(","),
      caption: buildCaption(carousel),
      access_token: pageAccessToken,
    }),
  });
  const carouselData = await carouselResp.json();
  if (carouselData.error) {
    throw new Error(`Failed to create carousel container: ${carouselData.error.message}`);
  }

  const containerId = carouselData.id;
  logger.info(`[ig-publish] Carousel container created: ${containerId}`);

  // Step 3: Wait for container to be ready, then publish
  await waitForContainerReady(igUserId, containerId, pageAccessToken);

  const publishResp = await fetch(`${GRAPH_BASE}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      creation_id: containerId,
      access_token: pageAccessToken,
    }),
  });
  const publishData = await publishResp.json();
  if (publishData.error) {
    throw new Error(`Failed to publish carousel: ${publishData.error.message}`);
  }

  const igPostId = publishData.id;
  logger.info(`[ig-publish] Carousel published! Post ID: ${igPostId}`);

  // Update carousel record
  await Carousel.findByIdAndUpdate(carouselId, {
    posted_to_ig: true,
    ig_post_id: igPostId,
    ig_posted_at: new Date(),
  });

  return { ig_post_id: igPostId };
}

/**
 * Poll container status until it's FINISHED (ready to publish).
 */
async function waitForContainerReady(igUserId, containerId, accessToken, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch(
      `${GRAPH_BASE}/${containerId}?fields=status_code&access_token=${accessToken}`,
    );
    const data = await resp.json();

    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR") {
      throw new Error("Container processing failed on Instagram's side");
    }

    // Wait 2 seconds before next check
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Container processing timed out");
}

function buildCaption(carousel) {
  let caption = carousel.caption || "";
  if (carousel.hashtags?.length > 0) {
    caption += "\n.\n.\n.\n" + carousel.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  }
  return caption;
}

module.exports = { publishToInstagram };

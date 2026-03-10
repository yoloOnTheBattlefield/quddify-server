const Replicate = require("replicate");
const Account = require("../../models/Account");
const Client = require("../../models/Client");
const ClientImage = require("../../models/ClientImage");
const { upload } = require("../storageService");
const logger = require("../../utils/logger").child({ module: "imageGenerator" });

async function getReplicateClient(accountId) {
  const account = await Account.findById(accountId);
  const token = account?.replicate_token
    ? Account.decryptField(account.replicate_token)
    : process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("No Replicate token available");
  return new Replicate({ auth: token });
}

/**
 * Generate an image using FLUX 1.1 Pro via Replicate.
 * @param {Object} opts
 * @param {string} opts.accountId
 * @param {string} opts.clientId
 * @param {string} opts.prompt - Image generation prompt
 * @param {Object} [opts.brandKit] - Client brand kit for style guidance
 * @returns {Object} Generated ClientImage document
 */
async function generateImage({ accountId, clientId, prompt, brandKit }) {
  const replicate = await getReplicateClient(accountId);

  // Build a detailed prompt incorporating brand style
  let fullPrompt = prompt;
  if (brandKit) {
    const styleNotes = [];
    if (brandKit.style_notes) styleNotes.push(brandKit.style_notes);
    if (brandKit.primary_color) styleNotes.push(`brand color scheme: ${brandKit.primary_color}`);
    if (styleNotes.length) {
      fullPrompt += `. Style: ${styleNotes.join(", ")}`;
    }
  }

  logger.info(`Generating image with FLUX: "${fullPrompt.substring(0, 100)}..."`);

  const output = await replicate.run("black-forest-labs/flux-1.1-pro", {
    input: {
      prompt: fullPrompt,
      width: 1080,
      height: 1350,
      num_inference_steps: 25,
      guidance_scale: 3.5,
    },
  });

  // FLUX returns a URL or file output — fetch the image
  const imageUrl = Array.isArray(output) ? output[0] : output;
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to fetch generated image: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const key = `clients/${clientId}/ai-generated/${Date.now()}-flux.png`;

  await upload(key, buffer, "image/png");

  // Create ClientImage record
  const image = await ClientImage.create({
    client_id: clientId,
    account_id: accountId,
    storage_key: key,
    original_filename: `ai-generated-${Date.now()}.png`,
    mime_type: "image/png",
    width: 1080,
    height: 1350,
    file_size: buffer.length,
    is_ai_generated: true,
    source: "ai_generated",
    status: "ready",
    quality_score: 70, // Default score for AI images
    text_safe_zones: { top: true, bottom: true, left: true, right: true },
    subject_position: "center",
  });

  logger.info(`Generated AI image ${image._id} (${buffer.length} bytes)`);
  return image;
}

/**
 * Generate a contextual prompt for a carousel slide that needs an AI image.
 */
function buildImagePrompt(slide, goal, clientName) {
  const rolePrompts = {
    hook: "Eye-catching, bold, scroll-stopping Instagram post image",
    pain: "Evocative image showing struggle or challenge",
    agitate: "Intense, emotional image emphasizing frustration",
    solution: "Confident, aspirational image showing transformation",
    proof: "Professional, credible image conveying authority and results",
    teaching: "Clean, focused image suitable for educational content",
    bridge: "Relatable, authentic lifestyle image",
    cta: "Inviting, warm image that encourages action",
  };

  const base = rolePrompts[slide.role] || "Professional Instagram carousel slide image";
  const goalStyle = {
    saveable_educational: "clean, minimal, professional aesthetic",
    polarizing_authority: "bold, dramatic, high-contrast",
    emotional_story: "warm, authentic, emotional lighting",
    conversion_focused: "aspirational, lifestyle, premium feel",
  };

  const style = goalStyle[goal] || "professional Instagram aesthetic";

  return `${base}. ${style}. Suitable for Instagram carousel at 1080x1350. No text in the image. High quality photography style.`;
}

/**
 * Attempt face-swap using InsightFace on Replicate.
 * Falls back gracefully if no face reference images available.
 */
async function faceSwap({ accountId, clientId, sourceImageKey, targetFaceUrl }) {
  if (!targetFaceUrl) {
    logger.info("No face reference — skipping face swap");
    return null;
  }

  try {
    const replicate = await getReplicateClient(accountId);
    const { getPresignedUrl } = require("../storageService");
    const sourceUrl = await getPresignedUrl(sourceImageKey);

    const output = await replicate.run("lucataco/insightface:61e79db0a2eff29e0e727a06a68e928c946a0527e3a83c4ebf2e3e9a7ab3e41b", {
      input: {
        source: sourceUrl,
        target: targetFaceUrl,
      },
    });

    const resultUrl = Array.isArray(output) ? output[0] : output;
    const response = await fetch(resultUrl);
    if (!response.ok) throw new Error(`Face swap fetch failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const newKey = sourceImageKey.replace(".png", "-faceswap.png");
    await upload(newKey, buffer, "image/png");

    return newKey;
  } catch (err) {
    logger.warn(`Face swap failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Generate images for all slides that need AI-generated images.
 * @param {Object} opts
 * @param {string} opts.accountId
 * @param {string} opts.clientId
 * @param {Array} opts.slides - Slides with copy
 * @param {Array} opts.imageSelections - From imageSelector, with needs_ai_image flags
 * @param {string} opts.goal
 * @returns {Array} Updated image selections
 */
async function generateMissingImages({ accountId, clientId, slides, imageSelections, goal }) {
  const client = await Client.findById(clientId);
  const needsGeneration = imageSelections.filter((s) => s.needs_ai_image);

  if (needsGeneration.length === 0) {
    logger.info("No AI image generation needed");
    return imageSelections;
  }

  logger.info(`Generating ${needsGeneration.length} AI images`);

  // Generate sequentially to avoid rate limits
  for (const selection of needsGeneration) {
    const slide = slides.find((s) => s.position === selection.position);
    if (!slide) continue;

    try {
      const prompt = buildImagePrompt(slide, goal, client?.name);
      const image = await generateImage({
        accountId,
        clientId,
        prompt,
        brandKit: client?.brand_kit,
      });

      // Try face swap if client has reference faces
      if (client?.face_reference_images?.length > 0) {
        const swappedKey = await faceSwap({
          accountId,
          clientId,
          sourceImageKey: image.storage_key,
          targetFaceUrl: client.face_reference_images[0],
        });
        if (swappedKey) {
          await ClientImage.findByIdAndUpdate(image._id, { storage_key: swappedKey });
          image.storage_key = swappedKey;
        }
      }

      selection.image_id = image._id;
      selection.image_key = image.storage_key;
      selection.needs_ai_image = false;
      selection.is_ai_generated = true;
    } catch (err) {
      logger.error(`Failed to generate image for slide ${selection.position}: ${err.message}`);
      // Leave needs_ai_image = true so the pipeline knows it's missing
    }
  }

  return imageSelections;
}

module.exports = { generateImage, generateMissingImages, buildImagePrompt, faceSwap };

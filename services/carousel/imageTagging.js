const { getBuffer } = require("../storageService");
const ClientImage = require("../../models/ClientImage");
const { TAG_VOCABULARY } = require("./tagVocabulary");
const { getOpenAIClient } = require("../../utils/aiClients");
const logger = require("../../utils/logger").child({ module: "imageTagging" });

function buildSystemPrompt() {
  return `You are an expert image analyst for Instagram carousel generation. Analyze photos to extract rich metadata for matching images to carousel slides.

CRITICAL: You MUST ONLY use tags from the predefined lists below. Do NOT invent new tags. Be generous with tagging — assign every tag that genuinely applies. More tags = better matching.

ALLOWED TAGS:

emotion (pick 3-5, all that apply): ${TAG_VOCABULARY.emotion.join(", ")}

context (pick 1-3): ${TAG_VOCABULARY.context.join(", ")}

body_language (pick 2-3): ${TAG_VOCABULARY.body_language.join(", ")}

facial_expression (pick 1-3): ${TAG_VOCABULARY.facial_expression.join(", ")}

setting (pick 1-3): ${TAG_VOCABULARY.setting.join(", ")}

clothing (pick 2-3): ${TAG_VOCABULARY.clothing.join(", ")}

activity (pick 1-3): ${TAG_VOCABULARY.activity.join(", ")}

vibe (pick 3-4): ${TAG_VOCABULARY.vibe.join(", ")}

lighting (pick 1-2): ${TAG_VOCABULARY.lighting.join(", ")}

color_palette (pick 1-3): ${TAG_VOCABULARY.color_palette.join(", ")}

composition (pick 1-3): ${TAG_VOCABULARY.composition.join(", ")}

Return ONLY valid JSON:
{
  "tags": {
    "emotion": ["from list above"],
    "context": ["from list above"],
    "body_language": ["from list above"],
    "facial_expression": ["from list above"],
    "setting": ["from list above"],
    "clothing": ["from list above"],
    "activity": ["from list above"],
    "vibe": ["from list above"],
    "lighting": ["from list above"],
    "color_palette": ["from list above"],
    "composition": ["from list above"]
  },
  "quality_score": 1-10,
  "face_visibility_score": 0-10,
  "energy_level": 1-10,
  "text_safe_zones": { "top": true/false, "bottom": true/false, "left": true/false, "right": true/false },
  "subject_position": "center|left-third|right-third",
  "suitable_as_cover": true/false,
  "summary": "one sentence description"
}

Scoring guidelines (be critical and spread scores across the full range — avoid clustering around 80-90):
- quality_score: Score 1-10 (integer). 10 = magazine-quality (perfect sharpness, lighting, composition). 7-9 = good (well-lit, mostly sharp, decent composition). 4-6 = average (minor issues — slightly soft, mediocre lighting, busy background). 1-3 = poor (blurry, dark, bad framing, low resolution). Most casual phone photos should score 5-7, not 8+.
- face_visibility_score: Score 1-10. 10 = clear front-facing portrait. 7-9 = face clearly visible but angled/partial. 4-6 = face small or side-profile. 1-3 = face barely visible or obscured. 0 = no face at all.
- energy_level: Score 1-10. 10 = intense action/dynamic pose. 7-9 = active, engaged, expressive. 4-6 = calm, relaxed, neutral pose. 1-3 = still, passive, static.
- text_safe_zones: true if that area has enough empty/simple space to overlay text legibly.
- suitable_as_cover: true only if the image would genuinely stand out as a carousel cover (eye-catching, clear subject, strong composition, good lighting). Most images should be false.`;
}

const SYSTEM_PROMPT = buildSystemPrompt();

async function tagImage(imageId) {
  const image = await ClientImage.findById(imageId);
  if (!image) throw new Error(`Image ${imageId} not found`);

  try {
    await ClientImage.findByIdAndUpdate(imageId, { status: "processing" });

    // Read file from local storage and encode as base64
    const buffer = await getBuffer(image.storage_key);
    const base64 = buffer.toString("base64");
    const mimeType = image.mime_type || "image/jpeg";
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const openai = await getOpenAIClient({ accountId: image.account_id, clientId: image.client_id });

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this photo for Instagram carousel use." },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
      max_tokens: 1000,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty response from GPT-4o");

    const result = JSON.parse(content);

    await ClientImage.findByIdAndUpdate(imageId, {
      $set: {
        tags: result.tags || {},
        quality_score: result.quality_score || 0,
        face_visibility_score: result.face_visibility_score || 0,
        energy_level: result.energy_level || 0,
        text_safe_zones: result.text_safe_zones || { top: false, bottom: false, left: false, right: false },
        subject_position: result.subject_position || "center",
        suitable_as_cover: result.suitable_as_cover || false,
        summary: result.summary || "",
        status: "ready",
      },
    });

    logger.info(`Tagged image ${imageId} successfully`);
    return result;
  } catch (err) {
    logger.error(`Failed to tag image ${imageId}:`, err);
    await ClientImage.findByIdAndUpdate(imageId, { status: "failed" });
    throw err;
  }
}

/**
 * Process a batch of images. Runs concurrency-limited tagging.
 * @param {string[]} imageIds - Array of ClientImage IDs
 * @param {number} concurrency - Max concurrent GPT-4o calls (default 3)
 */
async function tagImageBatch(imageIds, concurrency = 3) {
  const results = [];
  const queue = [...imageIds];

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) break;
      try {
        const result = await tagImage(id);
        results.push({ id, status: "success", result });
      } catch (err) {
        results.push({ id, status: "failed", error: err.message });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
  await Promise.all(workers);

  logger.info(`Batch tagged ${results.filter((r) => r.status === "success").length}/${imageIds.length} images`);
  return results;
}

module.exports = { tagImage, tagImageBatch };

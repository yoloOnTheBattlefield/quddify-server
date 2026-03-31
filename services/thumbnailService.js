const sharp = require("sharp");
const https = require("https");
const http = require("http");
const ThumbnailJob = require("../models/ThumbnailJob");
const ClientImage = require("../models/ClientImage");
const Notification = require("../models/Notification");
const Client = require("../models/Client");
const ThumbnailTemplate = require("../models/ThumbnailTemplate");
const { upload, getBuffer } = require("./storageService");
const { getClaudeClient, getGeminiClient } = require("../utils/aiClients");
const logger = require("../utils/logger").child({ module: "thumbnailService" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updateJobStatus(jobId, status, step, progress, io) {
  const update = { status, current_step: step, progress };
  if (status === "completed") update.completed_at = new Date();
  if (status === "generating" && progress <= 5) update.started_at = new Date();

  await ThumbnailJob.findByIdAndUpdate(jobId, update);

  if (io) {
    const job = await ThumbnailJob.findById(jobId, "account_id").lean();
    io.to(`account:${job.account_id}`).emit("thumbnail:job:update", { jobId, status, step, progress });
  }
}

function fetchUrl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: timeoutMs, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ---------------------------------------------------------------------------
// Competitor thumbnail search
// ---------------------------------------------------------------------------

async function searchCompetitorThumbnails(topic, accountId, jobId) {
  const { google } = require("googleapis");

  const account = await Account.findById(accountId, "gemini_token").lean();
  const apiKey = (account && decrypt(account.gemini_token)) || process.env.GEMINI || process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    logger.warn("No API key for YouTube search — skipping competitor examples");
    return [];
  }

  try {
    const youtube = google.youtube({ version: "v3", auth: apiKey });
    const searchRes = await youtube.search.list({
      part: "snippet",
      q: topic,
      type: "video",
      order: "viewCount",
      maxResults: 5,
    });

    const items = searchRes.data.items || [];
    if (items.length === 0) return [];

    const examples = [];
    for (const item of items) {
      const thumbUrl =
        item.snippet.thumbnails?.maxres?.url ||
        item.snippet.thumbnails?.high?.url ||
        item.snippet.thumbnails?.medium?.url;
      if (!thumbUrl) continue;

      try {
        const buf = await fetchUrl(thumbUrl);
        if (buf.length < 100 || buf.slice(0, 15).toString().includes("<!DOCTYPE")) continue;
        const key = `${accountId}/thumbnails/${jobId}/examples/${item.id.videoId}.jpg`;
        await upload(key, buf, "image/jpeg");
        examples.push({ key, title: item.snippet.title, channel: item.snippet.channelTitle, buffer: buf });
      } catch (err) {
        logger.warn(`Failed to download thumbnail for ${item.snippet.title}:`, err.message);
      }
    }
    logger.info(`Downloaded ${examples.length} competitor thumbnails for "${topic}"`);
    return examples;
  } catch (err) {
    logger.warn("YouTube search failed — skipping competitor examples:", err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reference image fetching
// ---------------------------------------------------------------------------

async function fetchReferenceImages(urls, accountId, jobId) {
  const refs = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const buf = await fetchUrl(url);
      if (buf.length < 100) continue;
      const header = buf.slice(0, 256).toString();
      if (header.includes("<!DOCTYPE") || header.includes("<html") || header.includes("<HTML")) {
        logger.warn(`Reference URL returned HTML, skipping: ${url}`);
        continue;
      }
      const key = `${accountId}/thumbnails/${jobId}/refs/ref-${i}.png`;
      await upload(key, buf, "image/png");
      refs.push({ key, url, buffer: buf });
    } catch (err) {
      logger.warn(`Failed to fetch reference image: ${url}`, err.message);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Brand style guide builder
// ---------------------------------------------------------------------------

function buildBrandStyle(client) {
  if (!client?.brand_kit) return "";
  const bk = client.brand_kit;
  const parts = [];
  if (bk.primary_color && bk.primary_color !== "#000000") parts.push(`Primary brand color: ${bk.primary_color}`);
  if (bk.secondary_color && bk.secondary_color !== "#ffffff") parts.push(`Secondary color: ${bk.secondary_color}`);
  if (bk.accent_color) parts.push(`Accent color: ${bk.accent_color}`);
  if (bk.font_heading) parts.push(`Heading font style: ${bk.font_heading}`);
  if (bk.style_notes) parts.push(`Style notes: ${bk.style_notes}`);
  return parts.length > 0 ? parts.join("\n") : "";
}

// ---------------------------------------------------------------------------
// AI-driven prompt crafting with Claude
// ---------------------------------------------------------------------------

async function craftPromptsWithAI(topic, brandStyle, exampleNotes, claude) {
  const systemPrompt = `You are an expert YouTube thumbnail designer. You understand the 3-step click decision (Visual Stun Gun → Title Value Hunt → Visual Validation) and desire loop frameworks.

Your job: Given a video topic, craft 4 ENTIRELY DIFFERENT Gemini image generation prompts for YouTube thumbnails. Each must use the exact prompt template below but with different creative directions.

PROMPT TEMPLATE (use this structure for each concept):
"""
A professional YouTube video thumbnail in 16:9 aspect ratio.

ATTACHED IMAGES:
- Image 1 (headshot): Reference photo of the person to include. Use their exact likeness.

PERSON:
Use the likeness from the headshot (Image 1). Place them on the right side of the frame, taking up approximately 40% of the width. Show them from the waist up or shoulders up. They should have dramatic, natural lighting on their face with the dark background behind them. They are looking [toward the camera / slightly toward the left side elements]. Their expression is [confident / excited / curious / serious].

BACKGROUND:
Dark, moody, cinematic background — NOT a solid black void. Use a darkened real-world scene or environment relevant to the video topic. The scene should feel like dramatic night photography or heavy cinematic color grading — dark overall but with real environmental detail, texture, and depth. [color_direction] color tones. No glow effects. No bright or white backgrounds, and never a flat solid-color void.

VISUAL ELEMENTS (left side):
[visual_elements_description]

TEXT:
"[thumbnail_text]" in bold, large, white text. Placed [text_position]. Clean, heavy, modern sans-serif font. High contrast against the dark background. Must be clearly readable.

STYLE:
Professional, high-contrast, clean design. Similar to top YouTube tech/business channel thumbnails. Dramatic lighting on the person. Subtle depth with layered elements. Polished and modern — not cluttered.
"""

DESIRE LOOP — work through this:
1. What desire does this video trigger?
2. What pain point does the viewer have?
3. What solution/transformation does the video deliver?
4. What's the curiosity loop?

VARY the 4 concepts across:
- Visual elements: different objects, props (end state vs process vs before/after vs pain point)
- Text: different words that COMPLEMENT the title (never repeat it)
- Color direction: warm vs cool vs bold vs minimal
- Person expression: confident vs excited vs serious vs curious
- Composition: asymmetrical vs symmetrical vs A→B split

RULES:
- Maximum 3 elements per thumbnail (face + text + object)
- Text: 3-5 words max, must complement not repeat the title
- Everything large — readable at 320x180px
- Never place elements in bottom-right (YouTube timestamp)
- NO graphic overlays, visual effects, or extra objects like cracked glass, shattered elements, chains, lightning, fire, etc. The thumbnail should be: person + text + background environment ONLY.
- NO infographic-style elements — no icons, charts, UI elements, arrows, percentage graphics, emoji symbols.
- ONE clear visual concept per image. Do not try to tell multiple stories or combine multiple ideas in one frame.
- Frame the subject tighter — slightly off-center, more face emphasis. Face or upper torso should dominate the frame. Real YouTube thumbnails crop aggressively.

CRITICAL: Each prompt must be UNDER 800 characters total. Keep them short and direct. Do not repeat the template structure — just fill in the specific creative details (expression, text words, color direction). Gemini works better with concise prompts.

Respond with ONLY valid JSON — array of 4 objects with:
- "label": "A"/"B"/"C"/"D"
- "description": 1-sentence concept description
- "prompt": a SHORT Gemini prompt (under 800 chars) following the template above`;

  const safeTopic = sanitizeTopic(topic);
  const userMessage = `Video topic: "${safeTopic}"

IMPORTANT: The prompts you write will be sent to Gemini image generation. Keep each prompt UNDER 800 characters. Do NOT include body weight numbers, body fat percentages, or body shaming language — Gemini will reject those. Use aspirational language instead.

${brandStyle ? `BRAND STYLE:\n${brandStyle}\n` : ""}
${exampleNotes ? `COMPETITOR OBSERVATIONS:\n${exampleNotes}\n` : ""}
Generate 4 thumbnail concept prompts. Return ONLY valid JSON array.`;

  try {
    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    let text = response.content[0]?.text?.trim() || "";
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const concepts = JSON.parse(text);

    if (!Array.isArray(concepts) || concepts.length !== 4) {
      throw new Error("Claude returned invalid concept structure");
    }
    return concepts;
  } catch (err) {
    logger.error("AI prompt crafting failed, falling back to templates:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Topic sanitizer — avoid Gemini safety triggers
// ---------------------------------------------------------------------------

function sanitizeTopic(topic) {
  // Replace body-weight/size language that triggers safety filters
  return topic
    .replace(/\d+\s*lbs?\b/gi, "")
    .replace(/\d+%\s*body\s*fat/gi, "")
    .replace(/\bfat\b/gi, "unfit")
    .replace(/\bjacked\b/gi, "fit")
    .replace(/\bskinny\b/gi, "lean")
    .replace(/\bobese\b/gi, "out of shape")
    .replace(/\bshredded\b/gi, "in great shape")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Static fallback prompts (original skill template)
// ---------------------------------------------------------------------------

function craftStaticPrompts(topic) {
  topic = sanitizeTopic(topic);
  const base = `A professional YouTube video thumbnail in 16:9 aspect ratio.

ATTACHED IMAGES:
- Image 1 (headshot): Reference photo of the person to include. Use their exact likeness.

PERSON:
Use the likeness from the headshot (Image 1). Place them on the right side of the frame, taking up approximately 40% of the width. Show them from the waist up or shoulders up. They should have dramatic, natural lighting on their face with the dark background behind them.

BACKGROUND:
Dark, moody, cinematic background — NOT a solid black void. Use a darkened real-world scene or environment relevant to "${topic}". The scene should feel like dramatic night photography or heavy cinematic color grading — dark overall but with real environmental detail, texture, and depth. No glow effects. No bright or white backgrounds, and never a flat solid-color void.

STYLE:
Professional, high-contrast, clean design. Similar to top YouTube tech/business channel thumbnails. Dramatic lighting on the person. Subtle depth with layered elements. Polished and modern — not cluttered.

IMPORTANT RULES:
- Never place important elements in the bottom-right corner (YouTube timestamp covers it).
- Keep elements large — must be legible at 320x180px. Maximum 3-5 words of text.
- Text must COMPLEMENT the video title, never repeat it.
- Limit graphic elements. Avoid infographic style icons, charts, UI elements, arrows, percentage graphics, or emoji symbols. Use at most 1 strong visual idea with minimal overlays.
- Focus on one clear visual concept per image. Do not combine multiple ideas or stories in one frame.
- Frame the subject tighter — slightly off-center, more face emphasis. Face or upper torso should dominate the frame.`;

  return [
    {
      label: "A",
      description: "Confident expression, warm accents, desire-triggering text",
      prompt: `${base}\n\nTheir expression is confident, with a knowing smile. Looking slightly toward camera.\n\nDo NOT add any graphic overlays, visual effects, or extra objects. The thumbnail should be: person + text + background environment only.\n\nTEXT:\n2-3 bold words that trigger the desire or solution feeling for "${topic}". Bold, large, white text in the upper area. Heavy modern sans-serif font.\n\nCOLOR DIRECTION: Dark background with warm orange/gold accents.`,
    },
    {
      label: "B",
      description: "Concerned expression, cool tones, big number or stat",
      prompt: `${base}\n\nTheir expression is genuine concern/seriousness. Looking toward camera.\n\nDo NOT add any graphic overlays, visual effects, or extra objects. The thumbnail should be: person + text + background environment only.\n\nTEXT:\nA big, round number or short stat related to "${topic}" that creates urgency. Make it huge, bold. White or bright red text. Heavy sans-serif font.\n\nCOLOR DIRECTION: Dark background with cool blue/cyan accents.`,
    },
    {
      label: "C",
      description: "Excited expression, bold color contrast, punchy text",
      prompt: `${base}\n\nTheir expression is natural excitement/surprise — not exaggerated. Looking toward camera.\n\nDo NOT add any graphic overlays, visual effects, or extra objects. The thumbnail should be: person + text + background environment only.\n\nTEXT:\n2 words maximum that trigger curiosity about "${topic}". Bold, slightly angled, white text.\n\nCOLOR DIRECTION: Bold saturated accent color that creates contrast.`,
    },
    {
      label: "D",
      description: "Direct authority expression, minimal, maximum contrast",
      prompt: `${base}\n\nTheir expression is direct and authoritative. Looking straight at camera. Strong directional lighting creating dramatic shadows on face.\n\nDo NOT add any graphic overlays, visual effects, or extra objects. The thumbnail should be: person + text + background environment only.\n\nTEXT:\n1-2 words maximum. Bold, large, white text against dark area.\n\nCOLOR DIRECTION: Maximum contrast — dark vs bright. High saturation.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Overlay real headshot onto generated thumbnail (replaces AI face)
// ---------------------------------------------------------------------------

async function overlayRealHeadshot(thumbnailBuffer, headshotBuffer) {
  const THUMB_W = 1280;
  const THUMB_H = 720;
  const PERSON_WIDTH = Math.round(THUMB_W * 0.38);
  const FADE_WIDTH = 100;

  // Resize generated thumbnail
  const thumb = await sharp(thumbnailBuffer).resize(THUMB_W, THUMB_H, { fit: "cover" }).ensureAlpha().png().toBuffer();

  // Crop headshot to fit the right portion
  const headMeta = await sharp(headshotBuffer).metadata();
  const headW = headMeta.width || 800;
  const headH = headMeta.height || 1000;

  const targetAspect = PERSON_WIDTH / THUMB_H;
  const headAspect = headW / headH;

  let cropTop = 0, cropHeight = headH, cropLeft = 0, cropWidth = headW;

  if (headAspect < targetAspect) {
    cropHeight = Math.round(headW / targetAspect);
    cropTop = Math.round(headH * 0.05);
    if (cropTop + cropHeight > headH) cropTop = Math.max(0, headH - cropHeight);
  } else {
    cropWidth = Math.round(headH * targetAspect);
    cropLeft = Math.round((headW - cropWidth) / 2);
  }

  const croppedHead = await sharp(headshotBuffer)
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .resize(PERSON_WIDTH, THUMB_H, { fit: "cover" })
    .ensureAlpha()
    .png()
    .toBuffer();

  // Sample the thumbnail's right-side color to tint the headshot for matching
  const sampleRegion = await sharp(thumb)
    .extract({ left: THUMB_W - PERSON_WIDTH, top: 0, width: PERSON_WIDTH, height: THUMB_H })
    .stats();

  const sceneR = Math.round(sampleRegion.channels[0].mean);
  const sceneG = Math.round(sampleRegion.channels[1].mean);
  const sceneB = Math.round(sampleRegion.channels[2].mean);
  const sceneBrightness = (sceneR + sceneG + sceneB) / 3;

  // Adjust headshot brightness to match scene
  const headStats = await sharp(croppedHead).stats();
  const headBrightness = (headStats.channels[0].mean + headStats.channels[1].mean + headStats.channels[2].mean) / 3;
  const brightnessMul = Math.max(0.5, Math.min(1.5, 1 + ((sceneBrightness - headBrightness) * 0.4) / 200));

  let adjusted = await sharp(croppedHead)
    .modulate({ brightness: brightnessMul })
    .ensureAlpha()
    .png()
    .toBuffer();

  // Light color tint to match scene temperature
  const tintStrength = 0.12;
  const tint = await sharp({
    create: {
      width: PERSON_WIDTH, height: THUMB_H, channels: 4,
      background: { r: Math.round(sceneR * tintStrength), g: Math.round(sceneG * tintStrength), b: Math.round(sceneB * tintStrength), alpha: Math.round(255 * tintStrength) },
    },
  }).png().toBuffer();

  adjusted = await sharp(adjusted).composite([{ input: tint, blend: "over" }]).ensureAlpha().png().toBuffer();

  // Gradient fade mask on left edge
  const gradientSvg = `<svg width="${PERSON_WIDTH}" height="${THUMB_H}">
    <defs>
      <linearGradient id="fade" x1="0" y1="0" x2="${FADE_WIDTH}" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="white" stop-opacity="0"/>
        <stop offset="1" stop-color="white" stop-opacity="1"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${FADE_WIDTH}" height="${THUMB_H}" fill="url(#fade)"/>
    <rect x="${FADE_WIDTH}" y="0" width="${PERSON_WIDTH - FADE_WIDTH}" height="${THUMB_H}" fill="white" fill-opacity="1"/>
  </svg>`;

  const maskRGBA = await sharp(Buffer.from(gradientSvg)).resize(PERSON_WIDTH, THUMB_H).ensureAlpha().png().toBuffer();
  const maskedHead = await sharp(adjusted).composite([{ input: maskRGBA, blend: "dest-in" }]).png().toBuffer();

  // Composite onto thumbnail
  const personX = THUMB_W - PERSON_WIDTH;
  return sharp(thumb)
    .composite([{ input: maskedHead, top: 0, left: personX }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Gemini image generation
// ---------------------------------------------------------------------------

function buildContents(prompt, headshotBuffer, headshotMime, referenceBuffers, exampleBuffers) {
  const contents = [
    { text: prompt },
    { inlineData: { data: headshotBuffer.toString("base64"), mimeType: headshotMime || "image/jpeg" } },
  ];

  for (const ref of referenceBuffers) {
    contents.push({ inlineData: { data: ref.toString("base64"), mimeType: "image/png" } });
  }

  if (exampleBuffers.length > 0) {
    contents.push({
      text: "\n\nSTYLE EXAMPLES:\nThe following images are thumbnails from high-performing YouTube videos on this topic. Study their composition, color usage, text placement, and visual hierarchy — then apply those patterns to create an ORIGINAL thumbnail. Do NOT copy these thumbnails.",
    });
    for (const ex of exampleBuffers) {
      contents.push({ inlineData: { data: ex.toString("base64"), mimeType: "image/jpeg" } });
    }
  }

  return contents;
}

async function callGeminiImageGen(client, contents, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents,
        config: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: "16:9" },
        },
      });

      if (!response.candidates || !response.candidates[0] || !response.candidates[0].content) {
        if (attempt < retries) {
          logger.warn(`Gemini returned no candidates (attempt ${attempt + 1}/${retries + 1}), retrying...`);
          continue;
        }
        throw new Error("Gemini returned no candidates after retries — prompt may have been filtered");
      }
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          return Buffer.from(part.inlineData.data, "base64");
        }
      }
      if (attempt < retries) {
        logger.warn(`No image in response (attempt ${attempt + 1}/${retries + 1}), retrying...`);
        continue;
      }
      throw new Error("No image returned from Gemini after retries");
    } catch (err) {
      if (attempt < retries && (err.message.includes("no candidates") || err.message.includes("No image"))) {
        logger.warn(`Gemini generation failed (attempt ${attempt + 1}), retrying...`);
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Combine thumbnails into 2x2 grid
// ---------------------------------------------------------------------------

async function combineGrid(buffers, labels) {
  const THUMB_W = 640;
  const THUMB_H = 360;
  const GAP = 8;
  const count = buffers.length;

  if (count === 1) {
    return sharp(buffers[0]).resize(THUMB_W, THUMB_H, { fit: "cover" }).png().toBuffer();
  }

  const cols = 2;
  const rows = Math.ceil(count / cols);
  const GRID_W = THUMB_W * cols + GAP * (cols - 1);
  const GRID_H = THUMB_H * rows + GAP * (rows - 1);

  const resized = await Promise.all(
    buffers.map((buf) => sharp(buf).resize(THUMB_W, THUMB_H, { fit: "cover" }).png().toBuffer()),
  );

  const withLabels = await Promise.all(
    resized.map((buf, i) => {
      const label = labels[i] || "";
      const svg = `<svg width="${THUMB_W}" height="${THUMB_H}">
        <rect x="0" y="0" width="${THUMB_W}" height="32" fill="rgba(0,0,0,0.7)" />
        <text x="12" y="22" font-family="sans-serif" font-size="18" font-weight="bold" fill="white">${label}</text>
      </svg>`;
      return sharp(buf)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .png()
        .toBuffer();
    }),
  );

  const composites = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    composites.push({
      input: withLabels[i],
      top: row * (THUMB_H + GAP),
      left: col * (THUMB_W + GAP),
    });
  }

  return sharp({
    create: { width: GRID_W, height: GRID_H, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 255 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function runThumbnailPipeline({ jobId, io }) {
  const job = await ThumbnailJob.findById(jobId);
  if (!job) throw new Error(`ThumbnailJob ${jobId} not found`);

  const accountId = job.account_id.toString();
  const clientId = job.client_id.toString();

  try {
    await updateJobStatus(jobId, "generating", "Preparing...", 2, io);

    const client = await Client.findById(clientId).lean();
    const brandStyle = buildBrandStyle(client);
    const gemini = await getGeminiClient({ accountId, clientId });

    // Load template if selected
    let template = null;
    if (job.template_id) {
      template = await ThumbnailTemplate.findById(job.template_id).lean();
      if (template) logger.info(`Using thumbnail template: ${template.name}`);
    }

    // Load headshot
    const headshot = await ClientImage.findById(job.headshot_image_id);
    if (!headshot) throw new Error("Headshot image not found");
    const headshotBuffer = await getBuffer(headshot.storage_key);

    // Competitor thumbnails
    await updateJobStatus(jobId, "generating", "Searching competitor thumbnails...", 5, io);
    const examples = await searchCompetitorThumbnails(job.topic, accountId, jobId);
    const exampleBuffers = examples.map((e) => e.buffer);

    // Reference images
    let referenceBuffers = [];
    if (job.reference_urls && job.reference_urls.length > 0) {
      await updateJobStatus(jobId, "generating", "Fetching reference images...", 10, io);
      const refs = await fetchReferenceImages(job.reference_urls, accountId, jobId);
      referenceBuffers = refs.map((r) => r.buffer);
    }

    // Example notes for Claude
    let exampleNotes = "";
    if (examples.length > 0) {
      exampleNotes = `Found ${examples.length} high-performing competitor thumbnails:\n`;
      examples.forEach((e, i) => { exampleNotes += `${i + 1}. "${e.title}" by ${e.channel}\n`; });
    }

    // AI prompt crafting
    await updateJobStatus(jobId, "generating", "Crafting 4 unique concepts with AI...", 15, io);
    let concepts;
    try {
      const claude = await getClaudeClient({ accountId, clientId });
      concepts = await craftPromptsWithAI(job.topic, brandStyle, exampleNotes, claude);
      if (!concepts) concepts = craftStaticPrompts(job.topic);
    } catch {
      logger.warn("Claude unavailable, using static prompts");
      concepts = craftStaticPrompts(job.topic);
    }

    // Inject template layout instructions
    if (template && template.prompt_instructions) {
      for (const c of concepts) {
        c.prompt += `\n\nLAYOUT TEMPLATE (follow this layout exactly):\n${template.prompt_instructions}`;
      }
    }

    // Brand style
    if (brandStyle) {
      for (const c of concepts) {
        c.prompt += `\n\nBRAND STYLE GUIDE:\n${brandStyle}`;
      }
    }

    // Reference image descriptions
    if (referenceBuffers.length > 0) {
      for (const c of concepts) {
        const refDesc = job.reference_urls
          .map((url, i) => `- Image ${i + 2} (reference): Downloaded from ${url}. Use this as a visual element in the thumbnail.`)
          .join("\n");
        c.prompt += `\n\nADDITIONAL REFERENCE IMAGES:\n${refDesc}`;
      }
    }

    await updateJobStatus(jobId, "generating", "Generating 4 thumbnail concepts...", 20, io);

    // Cap prompt length — Gemini filters overly long prompts
    for (const c of concepts) {
      if (c.prompt.length > 1500) {
        logger.warn(`Concept ${c.label} prompt too long (${c.prompt.length} chars), truncating`);
        c.prompt = c.prompt.substring(0, 1500);
      }
      logger.info(`Concept ${c.label} prompt: ${c.prompt.length} chars`);
    }

    // Generate all 4 in parallel
    const results = await Promise.allSettled(
      concepts.map(async (concept, i) => {
        const contents = buildContents(concept.prompt, headshotBuffer, headshot.mime_type, referenceBuffers, exampleBuffers);
        const genBuffer = await callGeminiImageGen(gemini, contents);

        // Overlay real headshot onto the generated thumbnail (preserves actual face)
        const imageBuffer = await overlayRealHeadshot(genBuffer, headshotBuffer);

        const key = `${accountId}/${clientId}/thumbnails/${jobId}/${concept.label}.png`;
        await upload(key, imageBuffer, "image/png");

        const pct = 25 + (i + 1) * 15;
        await updateJobStatus(jobId, "generating", `Generated concept ${concept.label}`, Math.min(pct, 85), io);
        return { ...concept, output_key: key };
      }),
    );

    const completedConcepts = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled") {
        completedConcepts.push(results[i].value);
      } else {
        logger.error(`Concept ${concepts[i].label} failed:`, results[i].reason);
        completedConcepts.push({ ...concepts[i], output_key: null, description: concepts[i].description + " (generation failed)" });
      }
    }

    if (completedConcepts.filter((c) => c.output_key).length === 0) {
      throw new Error("All 4 thumbnail generations failed");
    }

    // Combine grid
    await updateJobStatus(jobId, "combining", "Creating comparison grid...", 90, io);
    const successConcepts = completedConcepts.filter((c) => c.output_key);
    const thumbBuffers = await Promise.all(successConcepts.map((c) => getBuffer(c.output_key)));

    let comparisonKey = null;
    if (thumbBuffers.length >= 2) {
      const gridBuffer = await combineGrid(thumbBuffers, successConcepts.map((c) => c.label.toUpperCase()));
      comparisonKey = `${accountId}/${clientId}/thumbnails/${jobId}/comparison.png`;
      await upload(comparisonKey, gridBuffer, "image/png");
    }

    await ThumbnailJob.findByIdAndUpdate(jobId, {
      concepts: completedConcepts.map((c) => ({ label: c.label, description: c.description, prompt: c.prompt, output_key: c.output_key })),
      comparison_key: comparisonKey,
      example_count: examples.length,
    });

    await updateJobStatus(jobId, "completed", "Done", 100, io);

    try {
      await Notification.create({
        account_id: job.account_id, type: "thumbnail_ready", title: "Thumbnails Ready",
        message: `4 thumbnail concepts for ${client?.name || "client"} are ready to review`, client_id: clientId,
      });
    } catch (notifErr) { logger.error("Failed to create notification:", notifErr); }
  } catch (err) {
    logger.error("Thumbnail pipeline failed:", err);
    await ThumbnailJob.findByIdAndUpdate(jobId, { status: "failed", error: err.message, current_step: "failed" });
    if (io) {
      io.to(`account:${accountId}`).emit("thumbnail:job:update", { jobId, status: "failed", step: "failed", progress: 0, error: err.message });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Iteration
// ---------------------------------------------------------------------------

async function iterateThumbnail({ jobId, label, feedback, io }) {
  const job = await ThumbnailJob.findById(jobId);
  if (!job) throw new Error(`ThumbnailJob ${jobId} not found`);

  const concept = job.concepts.find((c) => c.label === label);
  if (!concept || !concept.output_key) throw new Error(`Concept ${label} not found or has no image`);

  const accountId = job.account_id.toString();
  const clientId = job.client_id.toString();

  const gemini = await getGeminiClient({ accountId, clientId });
  const headshot = await ClientImage.findById(job.headshot_image_id);
  const headshotBuffer = await getBuffer(headshot.storage_key);
  const prevBuffer = await getBuffer(concept.output_key);

  const iterationPrompt = `Edit this YouTube thumbnail. Keep the same overall composition and style.
The first attached image is a reference photo of the person — use their likeness.
The second attached image is the current thumbnail to modify.
Please make the following changes: ${feedback}`;

  const contents = [
    { text: iterationPrompt },
    { inlineData: { data: headshotBuffer.toString("base64"), mimeType: headshot.mime_type || "image/jpeg" } },
    { inlineData: { data: prevBuffer.toString("base64"), mimeType: "image/png" } },
  ];

  const imageBuffer = await callGeminiImageGen(gemini, contents);

  const version = job.iterations.length + 2;
  const key = `${accountId}/${clientId}/thumbnails/${jobId}/v${version}.png`;
  await upload(key, imageBuffer, "image/png");

  await ThumbnailJob.findByIdAndUpdate(jobId, { $push: { iterations: { label, feedback, output_key: key } } });
  return { output_key: key, version };
}

module.exports = { runThumbnailPipeline, iterateThumbnail };

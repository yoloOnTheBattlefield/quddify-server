const Carousel = require("../../models/Carousel");
const CarouselJob = require("../../models/CarouselJob");
const Client = require("../../models/Client");
const { selectImages, trackImageUsage } = require("./imageSelector");
const { generateMissingImages } = require("./imageGenerator");
const { renderSlides } = require("./slideRenderer");
const { getClaudeClient } = require("../../utils/aiClients");
const logger = require("../../utils/logger").child({ module: "topicPipeline" });

async function updateJobStatus(jobId, step, progress, io) {
  await CarouselJob.findByIdAndUpdate(jobId, {
    current_step: step,
    progress,
    ...(step === "completed" ? { completed_at: new Date() } : {}),
  });
  if (io) {
    const job = await CarouselJob.findById(jobId).lean();
    io.to(`account:${job.account_id}`).emit("carousel:job:update", { jobId, step, progress });
  }
}

/**
 * Generate carousel copy directly from a topic (no transcripts).
 */
async function generateCopyFromTopic({ accountId, clientId, topic, goal, slideCount, additionalInstructions }) {
  const client = await Client.findById(clientId);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const claude = await getClaudeClient({ accountId, clientId });
  const clientNiche = client.niche || "general";
  const voiceInstructions = client.voice_profile?.raw_text || "";
  const ctaDefaults = client.cta_defaults || {};
  const ctaText = ctaDefaults.primary_cta || "Save this for later";

  const goalDescriptions = {
    saveable_educational: "Maximize saves. Make it highly educational — give real value people want to bookmark.",
    polarizing_authority: "Be boldly opinionated. Take a strong stance that sparks debate and positions authority.",
    emotional_story: "Tell a compelling emotional story. Connect deeply through vulnerability and transformation.",
    conversion_focused: "Drive DMs and conversions. Agitate the problem, present the solution, make the next step obvious.",
  };

  const systemPrompt = `You are an elite Instagram carousel copywriter. You write copy that stops scrolls, earns swipes, and drives action.

You are ghostwriting as ${client.name}. Write in FIRST PERSON ("I", "my", "me"). The audience must feel like ${client.name} wrote this themselves.

NICHE: ${clientNiche}
${voiceInstructions ? `\nCLIENT VOICE:\n${voiceInstructions}` : ""}
${client.niche_playbook ? `\nNICHE PLAYBOOK:\n${client.niche_playbook.slice(0, 800)}` : ""}
${client.special_instructions ? `\nCLIENT SPECIAL INSTRUCTIONS (MUST follow):\n${client.special_instructions}` : ""}`;

  const slideInstruction = slideCount
    ? `Generate exactly ${slideCount} slides.`
    : `Generate as many slides as needed to tell the story properly (typically 7-15). Do NOT compress — each slide should be one idea, one beat. If the topic needs 12 slides, use 12.`;

  const userPrompt = `TOPIC: ${topic}
GOAL: ${goalDescriptions[goal] || goal}
CTA: "${ctaText}"

${slideInstruction}
${additionalInstructions ? `\n⚠️ MANDATORY USER INSTRUCTIONS (you MUST follow these precisely — they override any default behavior):\n${additionalInstructions}\n` : ""}

STANDARD SLIDE SEQUENCE (adapt to topic — not every carousel needs all types):

| # | Type | bg | Purpose |
|---|------|----|---------|
| 1 | hero | light | Hook — bold statement, logo lockup |
| 2 | problem | dark | Pain point — what's broken, frustrating, or outdated |
| 3 | solution | gradient | The answer — what solves it, optional quote |
| 4 | features | light | What you get — feature list with icons |
| 5 | details | dark | Depth — customization, specs, differentiators |
| 6 | how-to | light | Steps — numbered workflow or process |
| 7 | cta | gradient | Call to action — logo, tagline, CTA button. |

Rules:
- Alternate light/dark backgrounds for visual rhythm
- Start with a hook that stops the scroll
- End with CTA on gradient background
- Each slide: one idea, punchy copy (5-25 words for the headline)

COMPOSITION RULES (CRITICAL):
- Default to "single_hero" for MOST slides — this uses a background photo with text overlay. The client has a photo library and we want to use their images.
- Only use "text_only" for slides that have structured content (features list, numbered steps) where a background image would make the content unreadable.
- At least 60-70% of slides should be "single_hero".
- Hook slide: ALWAYS "single_hero"
- Problem/pain slides: "single_hero" (photo adds emotion)
- Solution slide: "single_hero" or "text_only"
- Features slide: "text_only" (structured content needs clean background)
- Steps/how-to slide: "text_only" (numbered list needs readability)
- CTA slide: "text_only" (gradient background with button)

SLIDE CONTENT TYPES — use these to make slides rich, not just text:

1. "tag" — Small uppercase label above the heading (e.g. "THE PROBLEM", "HOW IT WORKS")
2. "body" — Short body text below the headline (14px, lighter color)
3. "features" — Array of {icon, label, description} for feature/benefit slides
4. "steps" — Array of {title, description} for how-to/workflow slides
5. "pills" — Array of {label, strikethrough?} for tags or "old way" messaging
6. "quote" — {label, text} for testimonials or example prompts
7. "cta_text" — Button text for the final CTA slide

Return ONLY valid JSON:
{
  "slides": [
    {
      "position": 1,
      "role": "hook",
      "bg": "light",
      "composition": "single_hero",
      "copy": "Main headline text",
      "tag": "THE PROBLEM",
      "body": "Optional body text below the headline",
      "features": null,
      "steps": null,
      "pills": null,
      "quote": null,
      "cta_text": null,
      "why": "Brief explanation of copywriting technique"
    }
  ],
  "caption": "Full Instagram caption with line breaks",
  "hashtags": ["relevant", "hashtags"],
  "strategy_notes": "2-3 sentences on the copywriting strategy",
  "angle": {
    "chosen_angle": "the specific angle used",
    "angle_type": "topic",
    "supporting_excerpts": [],
    "hook_options": ["the hook used"],
    "why_this_angle": "why this angle works"
  }
}

EXAMPLES of rich slide content:

Feature slide:
{ "position": 4, "role": "features", "bg": "light", "composition": "text_only", "copy": "What You Get", "tag": "FEATURES", "features": [{"icon": "⚡", "label": "Lightning Fast", "description": "Results in under 60 seconds"}, {"icon": "🎨", "label": "Brand Match", "description": "Your colors, fonts, logo — automatic"}], "pills": null, "steps": null, "quote": null, "cta_text": null, "why": "Concrete benefits with icons for scannability" }

Steps slide:
{ "position": 6, "role": "how-to", "bg": "light", "composition": "text_only", "copy": "How It Works", "tag": "3 STEPS", "steps": [{"title": "Pick a vibe", "description": "Choose from proven templates"}, {"title": "Type your topic", "description": "AI writes everything"}, {"title": "Export & post", "description": "1080x1350 PNGs, ready to go"}], "features": null, "pills": null, "quote": null, "cta_text": null, "why": "Simple numbered process reduces friction" }

Problem slide with pills:
{ "position": 2, "role": "problem", "bg": "dark", "composition": "single_hero", "copy": "Still doing it the old way?", "tag": "THE PROBLEM", "pills": [{"label": "Canva", "strikethrough": true}, {"label": "Figma", "strikethrough": true}, {"label": "2 hours per post", "strikethrough": true}], "features": null, "steps": null, "quote": null, "cta_text": null, "why": "Strikethrough pills visualize what's being replaced" }

Solution slide with quote:
{ "position": 3, "role": "solution", "bg": "gradient", "composition": "text_only", "copy": "There's a better way.", "tag": "THE ANSWER", "quote": {"label": "Example prompt", "text": "Make me a carousel about 5 productivity hacks"}, "features": null, "steps": null, "pills": null, "cta_text": null, "why": "Quote box shows the product in action" }

CTA slide:
{ "position": 7, "role": "cta", "bg": "gradient", "composition": "text_only", "copy": "Ready to 10x your content?", "cta_text": "${ctaText}", "tag": null, "features": null, "steps": null, "pills": null, "quote": null, "why": "Direct CTA with button" }

Use the right content type for each slide. NOT every slide is just a headline — use features, steps, pills, quotes to make slides visually rich and varied.`;

  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    temperature: 0.4,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  let content = response.content?.[0]?.text;
  if (!content) throw new Error("Empty response from Claude");
  content = content.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(content);
}

/**
 * Simplified pipeline: topic → copy → images → render
 */
async function runTopicPipeline({ carouselId, jobId, io, topic, goal, slideCount, additionalInstructions }) {
  const carousel = await Carousel.findById(carouselId);
  if (!carousel) throw new Error(`Carousel ${carouselId} not found`);

  const log = [];
  const pushLog = (msg) => {
    log.push(`[${new Date().toISOString()}] ${msg}`);
    logger.info(msg);
  };

  try {
    await Carousel.findByIdAndUpdate(carouselId, { status: "generating" });
    await CarouselJob.findByIdAndUpdate(jobId, { status: "generating_copy", started_at: new Date() });

    // Step 1: Generate copy from topic
    await updateJobStatus(jobId, "generating_copy", 10, io);
    pushLog(`Generating copy for topic: "${topic}"`);

    const copyResult = await generateCopyFromTopic({
      accountId: carousel.account_id.toString(),
      clientId: carousel.client_id.toString(),
      topic,
      goal,
      slideCount,
      additionalInstructions,
    });

    pushLog(`Generated ${copyResult.slides.length} slides of copy`);

    const slidesDocs = copyResult.slides.map((s) => ({
      position: s.position,
      role: s.role,
      bg: s.bg || null,
      composition: s.composition || "single_hero",
      copy: s.copy,
      copy_why: s.why || "",
      tag: s.tag || null,
      body: s.body || null,
      features: s.features || null,
      steps: s.steps || null,
      pills: s.pills || null,
      quote: s.quote || null,
      cta_text: s.cta_text || null,
    }));

    await Carousel.findByIdAndUpdate(carouselId, {
      slides: slidesDocs,
      caption: copyResult.caption,
      hashtags: copyResult.hashtags,
      angle: copyResult.angle || {},
      strategy_notes: copyResult.strategy_notes || "",
    });

    // Step 2: Select images
    await updateJobStatus(jobId, "selecting_images", 35, io);
    pushLog("Selecting images from library...");

    let imageSelections = await selectImages({
      clientId: carousel.client_id.toString(),
      accountId: carousel.account_id.toString(),
      slides: copyResult.slides,
      goal,
    });

    const matched = imageSelections.filter((s) => !s.needs_ai_image).length;
    pushLog(`Matched ${matched}/${copyResult.slides.length} slides with existing images`);

    // Step 3: Generate AI images for unmatched
    const needsAI = imageSelections.filter((s) => s.needs_ai_image).length;
    if (needsAI > 0) {
      await updateJobStatus(jobId, "generating_images", 50, io);
      pushLog(`Generating ${needsAI} AI images...`);

      imageSelections = await generateMissingImages({
        accountId: carousel.account_id.toString(),
        clientId: carousel.client_id.toString(),
        slides: copyResult.slides,
        imageSelections,
        goal,
      });
    }

    // Update slides with image refs
    const updatedSlides = slidesDocs.map((slide) => {
      const sel = imageSelections.find((s) => s.position === slide.position);
      return {
        ...slide,
        image_id: sel?.image_id || null,
        image_key: sel?.image_key || null,
        extra_image_ids: sel?.extra_image_ids || [],
        extra_image_keys: sel?.extra_image_keys || [],
        is_ai_generated_image: sel?.is_ai_generated || false,
        image_selection_reason: sel?.image_selection_reason || "",
      };
    });

    await Carousel.findByIdAndUpdate(carouselId, { slides: updatedSlides });

    // Step 4: Render slides
    await updateJobStatus(jobId, "rendering_slides", 70, io);
    pushLog("Rendering slides to PNG...");

    const rendered = await renderSlides({
      carouselId: carouselId.toString(),
      clientId: carousel.client_id.toString(),
      accountId: carousel.account_id.toString(),
      slides: copyResult.slides,
      imageSelections,
      templateId: null,
      lutId: null,
    });

    const finalSlides = updatedSlides.map((slide) => {
      const r = rendered.find((rr) => rr.position === slide.position);
      return { ...slide, rendered_key: r?.rendered_key || null };
    });

    await Carousel.findByIdAndUpdate(carouselId, {
      slides: finalSlides,
      status: "ready",
      generation_log: log,
    });

    await updateJobStatus(jobId, "completed", 100, io);
    await CarouselJob.findByIdAndUpdate(jobId, { status: "completed" });

    pushLog(`Carousel ${carouselId} complete`);

    // Notification
    try {
      const Notification = require("../../models/Notification");
      const client = await Client.findById(carousel.client_id).lean();
      await Notification.create({
        account_id: carousel.account_id,
        type: "carousel_ready",
        title: "Carousel Ready",
        message: `Carousel for ${client?.name || "Unknown"} is ready — "${topic}"`,
        client_id: carousel.client_id,
        carousel_id: carouselId,
      });
    } catch (notifErr) {
      logger.error("Failed to create notification:", notifErr);
    }

    return { carouselId };
  } catch (err) {
    logger.error(`Topic pipeline failed for carousel ${carouselId}:`, err);

    try {
      await Carousel.findByIdAndUpdate(carouselId, {
        $set: { status: "failed" },
        $push: { generation_log: `[${new Date().toISOString()}] ERROR: ${err.message}` },
      });
    } catch (dbErr) {
      logger.error("Failed to update carousel status to failed:", dbErr);
    }

    await CarouselJob.findByIdAndUpdate(jobId, {
      status: "failed",
      error: err.message,
      completed_at: new Date(),
    });

    if (io) {
      const job = await CarouselJob.findById(jobId).lean();
      io.to(`account:${job.account_id}`).emit("carousel:job:update", {
        jobId,
        step: "failed",
        progress: 0,
        error: err.message,
      });
    }

    throw err;
  }
}

module.exports = { runTopicPipeline };

const Carousel = require("../../models/Carousel");
const CarouselJob = require("../../models/CarouselJob");
const ProspectProfile = require("../../models/ProspectProfile");
const { selectImages, trackImageUsage } = require("./imageSelector");
const { generateMissingImages } = require("./imageGenerator");
const { renderSlides } = require("./slideRenderer");
const { scoreCarousel } = require("./confidenceScorer");
const { getClaudeClient } = require("../../utils/aiClients");
const logger = require("../../utils/logger").child({ module: "outreachPipeline" });

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
 * Generate carousel copy using the prospect's profile instead of a client record.
 */
async function generateCopyFromProspect({ accountId, profile, topic, goal, slideCount, additionalInstructions }) {
  const claude = await getClaudeClient({ accountId });

  const prospectName = profile.profile?.name || profile.ig_handle;
  const niche = profile.profile?.niche || "general";
  const voiceNotes = profile.profile?.voice_notes || "";
  const coreMessage = profile.profile?.core_message || "";
  const offer = profile.profile?.offer || "";
  const audience = profile.profile?.audience || "";
  const ctaStyle = profile.profile?.cta_style || {};
  const ctaText = ctaStyle.detected_cta || "Link in bio";

  const goalDescriptions = {
    saveable_educational: "Maximize saves. Make it highly educational — give real value people want to bookmark.",
    polarizing_authority: "Be boldly opinionated. Take a strong stance that sparks debate and positions authority.",
    emotional_story: "Tell a compelling emotional story. Connect deeply through vulnerability and transformation.",
    conversion_focused: "Drive DMs and conversions. Agitate the problem, present the solution, make the next step obvious.",
  };

  const systemPrompt = `You are an elite Instagram carousel copywriter. You write copy that stops scrolls, earns swipes, and drives action.

You are ghostwriting in the style of a coach in this niche. Write in FIRST PERSON ("I", "my", "me"). The audience must feel like an expert in this space wrote it.

IMPORTANT: Do NOT include the person's name anywhere in the slide copy. No names on any slide — not in headlines, body text, CTAs, or tags.

NICHE: ${niche}
AUDIENCE: ${audience}
CORE MESSAGE: ${coreMessage}
${offer ? `OFFER/PRODUCT: ${offer}` : ""}

VOICE PROFILE (CRITICAL — match this exactly):
${voiceNotes}

This is an OUTREACH carousel — match the voice perfectly. Use their metaphors, sentence patterns, and energy level. Reference their specific product/program by name. But NEVER put the person's name on any slide.`;

  const slideInstruction = slideCount
    ? `Generate exactly ${slideCount} slides.`
    : `Generate 7 slides.`;

  const userPrompt = `TOPIC: ${topic}
GOAL: ${goalDescriptions[goal] || goal}
CTA: "${ctaText}"

${slideInstruction}
${additionalInstructions ? `\n⚠️ MANDATORY USER INSTRUCTIONS:\n${additionalInstructions}\n` : ""}

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
- Default to "single_hero" for MOST slides — this uses a background photo with text overlay.
- Only use "text_only" for slides that have structured content (features list, numbered steps).
- At least 60-70% of slides should be "single_hero".
- Hook slide: ALWAYS "single_hero"
- CTA slide: "text_only" (gradient background with button)

SLIDE CONTENT TYPES:
1. "tag" — Small uppercase label above the heading
2. "body" — Short body text below the headline
3. "features" — Array of {icon, label, description}
4. "steps" — Array of {title, description}
5. "pills" — Array of {label, strikethrough?}
6. "quote" — {label, text}
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
      "body": "Optional body text",
      "features": null,
      "steps": null,
      "pills": null,
      "quote": null,
      "cta_text": null,
      "why": "Brief explanation"
    }
  ],
  "caption": "Full Instagram caption with line breaks",
  "hashtags": ["relevant", "hashtags"],
  "strategy_notes": "2-3 sentences on the copywriting strategy",
  "angle": {
    "chosen_angle": "the specific angle used",
    "angle_type": "outreach",
    "supporting_excerpts": [],
    "hook_options": ["the hook used"],
    "why_this_angle": "why this angle works"
  }
}`;

  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    temperature: 0.4,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  // Track Claude cost: Sonnet 4 = $3/1M input, $15/1M output
  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  const claudeCostUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  let content = response.content?.[0]?.text;
  if (!content) throw new Error("Empty response from Claude");
  content = content.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();

  function attachCost(parsed) {
    parsed._claudeCostUsd = claudeCostUsd;
    parsed._claudeTokens = { input: inputTokens, output: outputTokens };
    return parsed;
  }

  try {
    return attachCost(JSON.parse(content));
  } catch (parseErr) {
    // Common issue: unescaped quotes or trailing commas in AI output. Try to fix.
    logger.warn(`JSON parse failed, attempting repair: ${parseErr.message}`);

    // Remove trailing commas before ] or }
    let fixed = content.replace(/,\s*([}\]])/g, "$1");
    // Escape unescaped newlines inside strings
    fixed = fixed.replace(/(?<=": "(?:[^"\\]|\\.)*)(\n)(?=[^"]*")/g, "\\n");

    try {
      return attachCost(JSON.parse(fixed));
    } catch {
      // Last resort: retry the API call once
      logger.warn("JSON repair failed, retrying API call...");
      const retry = await claude.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        temperature: 0.2,
        system: systemPrompt,
        messages: [
          { role: "user", content: userPrompt },
          { role: "assistant", content: content },
          { role: "user", content: "Your JSON response was malformed and could not be parsed. Please return the EXACT same content but as valid JSON. Ensure all strings are properly escaped and there are no trailing commas." },
        ],
      });

      // Add retry cost too
      const retryIn = retry.usage?.input_tokens || 0;
      const retryOut = retry.usage?.output_tokens || 0;
      const retryCost = (retryIn * 3 + retryOut * 15) / 1_000_000;

      let retryContent = retry.content?.[0]?.text;
      if (!retryContent) throw new Error("Empty retry response from Claude");
      retryContent = retryContent.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
      const parsed = JSON.parse(retryContent);
      parsed._claudeCostUsd = claudeCostUsd + retryCost;
      parsed._claudeTokens = { input: inputTokens + retryIn, output: outputTokens + retryOut };
      return parsed;
    }
  }
}

/**
 * Run the outreach carousel generation pipeline.
 */
async function runOutreachPipeline({ carouselId, jobId, profileId, io, topic, goal, slideCount, additionalInstructions }) {
  const carousel = await Carousel.findById(carouselId);
  if (!carousel) throw new Error(`Carousel ${carouselId} not found`);

  const profile = await ProspectProfile.findById(profileId);
  if (!profile) throw new Error(`ProspectProfile ${profileId} not found`);

  const log = [];
  const pushLog = (msg) => {
    log.push(`[${new Date().toISOString()}] ${msg}`);
    logger.info(msg);
  };

  try {
    await Carousel.findByIdAndUpdate(carouselId, { status: "generating" });
    await CarouselJob.findByIdAndUpdate(jobId, { status: "generating_copy", started_at: new Date() });

    // Step 1: Generate copy from prospect profile
    await updateJobStatus(jobId, "generating_copy", 10, io);
    pushLog(`Generating outreach copy for @${profile.ig_handle}: "${topic}"`);

    const copyResult = await generateCopyFromProspect({
      accountId: carousel.account_id.toString(),
      profile,
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

    // Step 2: Select images from prospect's scraped photos
    await updateJobStatus(jobId, "selecting_images", 35, io);
    pushLog("Selecting images from prospect photos...");

    let imageSelections = await selectImages({
      clientId: carousel.client_id.toString(),
      accountId: carousel.account_id.toString(),
      slides: copyResult.slides,
      goal,
      imageFilter: {
        prospect_profile_id: profileId,
        status: "ready",
      },
    });

    const matched = imageSelections.filter((s) => !s.needs_ai_image).length;
    pushLog(`Matched ${matched}/${copyResult.slides.length} slides with prospect photos`);

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

    // Step 4: Render slides with inferred brand colors
    await updateJobStatus(jobId, "rendering_slides", 70, io);
    pushLog("Rendering slides to PNG...");

    const brandKitOverride = {
      primary_color: profile.inferred_brand?.primary_color || "#000000",
      secondary_color: profile.inferred_brand?.secondary_color || "#ffffff",
      accent_color: profile.inferred_brand?.accent_color || "#3b82f6",
      font_heading: "Playfair Display",
      font_body: "DM Sans",
      name: profile.profile?.name || profile.ig_handle,
    };

    const rendered = await renderSlides({
      carouselId: carouselId.toString(),
      clientId: carousel.client_id.toString(),
      accountId: carousel.account_id.toString(),
      slides: copyResult.slides,
      imageSelections,
      templateId: null,
      lutId: null,
      showBrandName: false,
      brandKitOverride,
    });

    const finalSlides = updatedSlides.map((slide) => {
      const r = rendered.find((rr) => rr.position === slide.position);
      return { ...slide, rendered_key: r?.rendered_key || null };
    });

    // Step 5: Score confidence
    await updateJobStatus(jobId, "scoring", 90, io);
    pushLog("Scoring carousel confidence...");

    const confidence = await scoreCarousel({
      slides: copyResult.slides,
      imageSelections,
      transcriptIds: [],
      angle: copyResult.angle,
      goal,
      prospectProfile: profile.profile,
    });

    // Collect costs: scrape costs from ProspectProfile + generation Claude cost
    const latestProfile = await ProspectProfile.findById(profileId).select("cost").lean();
    const scrapeCost = latestProfile?.cost || {};
    const genClaudeCost = copyResult._claudeCostUsd || 0;
    const totalClaudeCost = (scrapeCost.claude_usd || 0) + genClaudeCost;
    const totalApifyCost = scrapeCost.apify_usd || 0;
    const totalOpenaiCost = scrapeCost.openai_usd || 0;
    const totalCost = totalApifyCost + totalClaudeCost + totalOpenaiCost;

    const costBreakdown = [];
    if (totalApifyCost > 0) costBreakdown.push({ label: "Apify (scraping)", usd: totalApifyCost });
    if (scrapeCost.openai_usd > 0) costBreakdown.push({ label: "OpenAI (image tagging)", usd: scrapeCost.openai_usd * 0.7 });
    if (scrapeCost.openai_usd > 0) costBreakdown.push({ label: "OpenAI (transcription)", usd: scrapeCost.openai_usd * 0.3 });
    if (scrapeCost.claude_usd > 0) costBreakdown.push({ label: "Claude (profile analysis)", usd: scrapeCost.claude_usd });
    if (genClaudeCost > 0) costBreakdown.push({ label: "Claude (copy generation)", usd: genClaudeCost });

    pushLog(`Cost: Apify $${totalApifyCost.toFixed(4)} | Claude $${totalClaudeCost.toFixed(4)} | OpenAI $${totalOpenaiCost.toFixed(4)} | Total $${totalCost.toFixed(4)}`);

    // Finalize
    await Carousel.findByIdAndUpdate(carouselId, {
      slides: finalSlides,
      confidence,
      cost: {
        apify_usd: Math.round(totalApifyCost * 10000) / 10000,
        claude_usd: Math.round(totalClaudeCost * 10000) / 10000,
        openai_usd: Math.round(totalOpenaiCost * 10000) / 10000,
        total_usd: Math.round(totalCost * 10000) / 10000,
        breakdown: costBreakdown,
      },
      status: "ready",
      generation_log: log,
    });

    await trackImageUsage(imageSelections, carouselId);
    await updateJobStatus(jobId, "completed", 100, io);
    await CarouselJob.findByIdAndUpdate(jobId, { status: "completed" });

    pushLog(`Outreach carousel ${carouselId} complete — confidence: ${confidence.overall}/100`);

    // Notification
    try {
      const Notification = require("../../models/Notification");
      await Notification.create({
        account_id: carousel.account_id,
        type: "carousel_ready",
        title: "Outreach Carousel Ready",
        message: `Outreach carousel for @${profile.ig_handle} is ready — confidence: ${confidence.overall}/100`,
        client_id: carousel.client_id,
        carousel_id: carouselId,
      });
    } catch (notifErr) {
      logger.error("Failed to create notification:", notifErr);
    }

    return { carouselId, confidence };
  } catch (err) {
    logger.error(`Outreach pipeline failed for carousel ${carouselId}:`, err);

    try {
      await Carousel.findByIdAndUpdate(carouselId, {
        $set: { status: "failed" },
        $push: { generation_log: `[${new Date().toISOString()}] ERROR: ${err.message}` },
      });
    } catch (dbErr) {
      logger.error("Failed to update carousel status:", dbErr);
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

module.exports = { runOutreachPipeline };

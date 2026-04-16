const express = require("express");
const router = express.Router();
const Carousel = require("../models/Carousel");
const CarouselJob = require("../models/CarouselJob");
const validate = require("../middleware/validate");
const carouselSchemas = require("../schemas/carousels");
const { getPresignedUrl } = require("../services/storageService");
const logger = require("../utils/logger").child({ module: "carousels" });
const { buildClientScopedFilter, findOwnedDoc, loadOwnedClient } = require("../utils/clientUserScope");

async function attachSlideUrls(carousel) {
  if (!carousel?.slides?.length) return carousel;
  const obj = carousel.toObject ? carousel.toObject() : { ...carousel };
  obj.slides = await Promise.all(
    obj.slides.map(async (slide) => {
      if (slide.rendered_key) {
        slide.rendered_url = await getPresignedUrl(slide.rendered_key, 3600);
      }
      return slide;
    }),
  );
  return obj;
}

// GET /api/carousels?client_id=xxx
router.get("/", async (req, res) => {
  try {
    // role=2 users have data under the creator's account_id, not their own.
    // Scope by client_id (their owned Clients) instead of account_id.
    const baseFilter = await buildClientScopedFilter(req);
    if (baseFilter === null) return res.json([]);
    const filter = { ...baseFilter };
    if (req.query.client_id) filter.client_id = req.query.client_id;
    if (req.query.status) filter.status = req.query.status;
    const carousels = await Carousel.find(filter).sort({ created_at: -1 }).limit(50);
    const withUrls = await Promise.all(carousels.map(attachSlideUrls));
    res.json(withUrls);
  } catch (err) {
    logger.error("Failed to list carousels:", err);
    res.status(500).json({ error: "Failed to list carousels" });
  }
});

// GET /api/carousels/:id
router.get("/:id", async (req, res) => {
  try {
    const carousel = await findOwnedDoc(Carousel, req, req.params.id);
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });
    res.json(await attachSlideUrls(carousel));
  } catch (err) {
    logger.error("Failed to get carousel:", err);
    res.status(500).json({ error: "Failed to get carousel" });
  }
});

// POST /api/carousels/generate-brief — AI-generate content brief from client data + transcripts
router.post("/generate-brief", validate(carouselSchemas.generateBrief), async (req, res) => {
  try {
    const { client_id, transcript_ids, goal } = req.body;

    const Transcript = require("../models/Transcript");
    const Anthropic = require("@anthropic-ai/sdk").default;
    const Account = require("../models/Account");

    const client = await loadOwnedClient(req, client_id);
    if (!client) return res.status(404).json({ error: "Client not found" });
    const transcripts = await Transcript.find({ _id: { $in: transcript_ids }, client_id: client._id });

    // Build transcript excerpts (truncate to keep prompt reasonable)
    const transcriptText = transcripts
      .map((t) => (t.cleaned_text || t.raw_text || "").slice(0, 2000))
      .join("\n---\n")
      .slice(0, 6000);

    const goalDescriptions = {
      saveable_educational: "Maximize saves — highly educational, real value people want to bookmark",
      polarizing_authority: "Bold takes that spark debate and position authority",
      emotional_story: "Story-driven emotional connection through vulnerability and transformation",
      conversion_focused: "Drive DMs and conversions — agitate problem, present solution, clear next step",
    };

    // Always read the Claude key from the Client's owning account, not
    // req.account (which for role=2 is the user's empty isolated account).
    const account = await Account.findById(client.account_id);
    const token = account?.claude_token
      ? Account.decryptField(account.claude_token)
      : process.env.CLAUDE;
    if (!token) return res.status(500).json({ error: "No Claude token available" });

    const claude = new Anthropic({ apiKey: token });

    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      temperature: 0.6,
      system: `You generate content brief suggestions for Instagram carousel slides. Return ONLY valid JSON, no markdown fencing.`,
      messages: [{
        role: "user",
        content: `Generate a content brief for a 7-slide Instagram carousel.

CLIENT: ${client.name}
NICHE: ${client.niche || "general"}
${client.voice_profile?.raw_text ? `VOICE: ${client.voice_profile.raw_text.slice(0, 500)}` : ""}
${client.niche_playbook ? `PLAYBOOK: ${client.niche_playbook.slice(0, 800)}` : ""}
${client.cta_defaults?.primary_cta ? `DEFAULT CTA: ${client.cta_defaults.primary_cta}` : ""}
GOAL: ${goalDescriptions[goal] || goal || "educational"}

TRANSCRIPT EXCERPTS:
${transcriptText || "No transcripts provided — generate based on niche and client profile."}

Generate a content brief with these fields. Each field should be a short, punchy direction (not final copy — just guidance for the AI copywriter). Keep each field under 20 words.

Return JSON:
{
  "topic": "the main topic or offer",
  "hook": "the bold claim or outcome for slide 1",
  "problem": "the pain point for slide 2",
  "solution": "the answer/big idea for slide 3",
  "features": ["feature 1", "feature 2", "feature 3", "feature 4"],
  "details": "differentiator or depth for slide 5",
  "steps": ["step 1", "step 2", "step 3"],
  "cta": "call to action for final slide"
}`,
      }],
    });

    let content = response.content?.[0]?.text;
    if (!content) return res.status(500).json({ error: "Empty AI response" });
    content = content.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const brief = JSON.parse(content);
    res.json(brief);
  } catch (err) {
    logger.error("Failed to generate brief:", err);
    res.status(500).json({ error: "Failed to generate content brief" });
  }
});

// POST /api/carousels/generate-from-topic — simple topic-based generation (no transcripts)
router.post("/generate-from-topic", validate(carouselSchemas.generateFromTopic), async (req, res) => {
  try {
    const { client_id, topic, goal, slide_count, additional_instructions, show_brand_name } = req.body;

    const client = await loadOwnedClient(req, client_id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const carousel = await Carousel.create({
      client_id,
      account_id: client.account_id,
      topic,
      transcript_ids: [],
      goal: goal || "saveable_educational",
      status: "queued",
    });

    const job = await CarouselJob.create({
      carousel_id: carousel._id,
      account_id: client.account_id,
      status: "queued",
    });

    // Run topic-based pipeline in background
    const { runTopicPipeline } = require("../services/carousel/topicPipeline");
    runTopicPipeline({
      carouselId: carousel._id.toString(),
      jobId: job._id.toString(),
      io: req.app.get("io"),
      topic,
      goal: goal || "saveable_educational",
      slideCount: slide_count || null,
      additionalInstructions: additional_instructions || "",
      showBrandName: show_brand_name === true,
    }).catch((err) => {
      logger.error("Background topic pipeline failed:", err);
    });

    res.status(201).json({ carousel, job });
  } catch (err) {
    logger.error("Failed to generate carousel from topic:", err);
    res.status(500).json({ error: "Failed to generate carousel" });
  }
});

// POST /api/carousels/generate — kick off carousel generation
router.post("/generate", validate(carouselSchemas.generate), async (req, res) => {
  try {
    const { client_id, transcript_ids, swipe_file_id, template_id, goal, copy_model, lut_id, style_id, style_prompt_override, layout_preset } = req.body;

    const client = await loadOwnedClient(req, client_id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    // Resolve style prompt from saved preset or override
    let stylePrompt = style_prompt_override || "";
    if (style_id && !stylePrompt) {
      const CarouselStyle = require("../models/CarouselStyle");
      const style = await CarouselStyle.findById(style_id);
      if (style) stylePrompt = style.style_prompt;
    }

    const carousel = await Carousel.create({
      client_id,
      account_id: client.account_id,
      transcript_ids,
      swipe_file_id: swipe_file_id || null,
      template_id: template_id || null,
      lut_id: lut_id || null,
      layout_preset: layout_preset || { mode: "ai_suggested" },
      goal: goal || "saveable_educational",
      status: "queued",
    });

    const job = await CarouselJob.create({
      carousel_id: carousel._id,
      account_id: client.account_id,
      status: "queued",
    });

    // Run pipeline in background — don't block the response
    const { runPipeline } = require("../services/carousel/carouselPipeline");
    runPipeline({
      carouselId: carousel._id.toString(),
      jobId: job._id.toString(),
      io: req.app.get("io"),
      copyModel: copy_model || "claude-sonnet",
      lutId: lut_id || null,
      stylePrompt: stylePrompt || null,
      layoutPreset: layout_preset || null,
    }).catch((err) => {
      logger.error("Background pipeline failed:", err);
    });

    res.status(201).json({ carousel, job });
  } catch (err) {
    logger.error("Failed to generate carousel:", err);
    res.status(500).json({ error: "Failed to generate carousel" });
  }
});

// GET /api/carousels/:id/download — download all slides as a zip
// Supports ?token= query param for direct browser downloads (window.open)
router.get("/:id/download", async (req, res) => {
  try {
    // Allow token via query param for direct browser download (no auth header)
    if (!req.account && req.query.token) {
      const jwt = require("jsonwebtoken");
      const Account = require("../models/Account");
      const { JWT_SECRET } = require("../middleware/auth");
      const decoded = jwt.verify(req.query.token, JWT_SECRET);
      const account = await Account.findById(decoded.accountId).lean();
      if (!account) return res.status(401).json({ error: "Invalid token" });
      req.account = account;
      req.user = decoded; // populate so ownership helpers work for role=2 too
    }
    const carousel = await findOwnedDoc(Carousel, req, req.params.id);
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });

    const renderedSlides = (carousel.slides || []).filter((s) => s.rendered_key);
    if (renderedSlides.length === 0) return res.status(404).json({ error: "No rendered slides" });

    const archiver = require("archiver");
    const { getBuffer } = require("../services/storageService");

    const archive = archiver("zip", { zlib: { level: 1 } });
    const safeTopic = (carousel.topic || "carousel").replace(/[^a-zA-Z0-9-_ ]/g, "").slice(0, 40).trim();
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="${safeTopic}.zip"`);
    archive.pipe(res);

    for (const slide of renderedSlides) {
      const buffer = await getBuffer(slide.rendered_key);
      archive.append(buffer, { name: `slide-${slide.position}.png` });
    }

    await archive.finalize();
  } catch (err) {
    logger.error("Failed to download carousel zip:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to download" });
  }
});

// GET /api/carousels/:id/slides/:position/download — proxy slide image from R2
router.get("/:id/slides/:position/download", async (req, res) => {
  try {
    const carousel = await findOwnedDoc(Carousel, req, req.params.id);
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });

    const slide = carousel.slides.find((s) => s.position === Number(req.params.position));
    if (!slide?.rendered_key) return res.status(404).json({ error: "Slide not rendered" });

    const { getBuffer } = require("../services/storageService");
    const buffer = await getBuffer(slide.rendered_key);
    res.set("Content-Type", "image/png");
    res.set("Content-Disposition", `attachment; filename="slide-${slide.position}.png"`);
    res.send(buffer);
  } catch (err) {
    logger.error("Failed to download slide:", err);
    res.status(500).json({ error: "Failed to download slide" });
  }
});

// GET /api/carousels/:id/job — get job status for a carousel
router.get("/:id/job", async (req, res) => {
  try {
    // Verify the user owns the carousel before exposing the job.
    const carousel = await findOwnedDoc(Carousel, req, req.params.id);
    if (!carousel) return res.status(404).json({ error: "Job not found" });
    const job = await CarouselJob.findOne({ carousel_id: req.params.id }).sort({ created_at: -1 });
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    logger.error("Failed to get job:", err);
    res.status(500).json({ error: "Failed to get job" });
  }
});

// PATCH /api/carousels/:id — update carousel (edit copy, swap image, etc.)
router.patch("/:id", async (req, res) => {
  try {
    const existing = await findOwnedDoc(Carousel, req, req.params.id);
    if (!existing) return res.status(404).json({ error: "Carousel not found" });
    const carousel = await Carousel.findByIdAndUpdate(existing._id, { $set: req.body }, { new: true });
    res.json(carousel);
  } catch (err) {
    logger.error("Failed to update carousel:", err);
    res.status(500).json({ error: "Failed to update carousel" });
  }
});

// POST /api/carousels/:id/apply-lut — re-render slides with a LUT applied
router.post("/:id/apply-lut", async (req, res) => {
  try {
    const { lut_id } = req.body;
    if (!lut_id) return res.status(400).json({ error: "lut_id is required" });

    const carousel = await findOwnedDoc(Carousel, req, req.params.id);
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });

    if (!carousel.slides || carousel.slides.length === 0) {
      return res.status(400).json({ error: "Carousel has no slides to re-render" });
    }

    const { renderSlides } = require("../services/carousel/slideRenderer");

    // Build imageSelections from existing slide data
    const imageSelections = carousel.slides.map((s) => ({
      position: s.position,
      image_key: s.image_key || null,
      image_id: s.image_id || null,
    }));

    const rendered = await renderSlides({
      carouselId: carousel._id.toString(),
      clientId: carousel.client_id.toString(),
      accountId: carousel.account_id.toString(),
      slides: carousel.slides,
      imageSelections,
      templateId: carousel.template_id?.toString(),
      lutId: lut_id,
    });

    // Update slides with new rendered keys
    const updatedSlides = carousel.slides.map((slide) => {
      const r = rendered.find((rr) => rr.position === slide.position);
      return {
        ...slide.toObject(),
        rendered_key: r?.rendered_key || slide.rendered_key,
      };
    });

    await Carousel.findByIdAndUpdate(carousel._id, {
      slides: updatedSlides,
      lut_id,
    });

    const updated = await Carousel.findById(carousel._id);
    res.json(updated);
  } catch (err) {
    logger.error("Failed to apply LUT:", err);
    res.status(500).json({ error: "Failed to apply LUT" });
  }
});

// POST /api/carousels/:id/regenerate — re-run the full pipeline for a failed/ready carousel
router.post("/:id/regenerate", async (req, res) => {
  try {
    const carousel = await findOwnedDoc(Carousel, req, req.params.id);
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });

    // Reset carousel status
    await Carousel.findByIdAndUpdate(carousel._id, { status: "queued" });

    const job = await CarouselJob.create({
      carousel_id: carousel._id,
      account_id: carousel.account_id,
      status: "queued",
    });

    const { runPipeline } = require("../services/carousel/carouselPipeline");
    runPipeline({
      carouselId: carousel._id.toString(),
      jobId: job._id.toString(),
      io: req.app.get("io"),
      copyModel: req.body.copy_model || "claude-sonnet",
      lutId: req.body.lut_id || carousel.lut_id?.toString() || null,
    }).catch((err) => {
      logger.error("Background regenerate pipeline failed:", err);
    });

    res.status(201).json({ carousel: { ...carousel.toObject(), status: "queued" }, job });
  } catch (err) {
    logger.error("Failed to regenerate carousel:", err);
    res.status(500).json({ error: "Failed to regenerate carousel" });
  }
});

// POST /api/carousels/:id/publish-ig — publish carousel to Instagram
router.post("/:id/publish-ig", async (req, res) => {
  try {
    const carousel = await findOwnedDoc(Carousel, req, req.params.id);
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });

    const { publishToInstagram } = require("../services/carousel/igPublisher");
    const result = await publishToInstagram({
      carouselId: carousel._id.toString(),
      accountId: carousel.account_id.toString(),
    });

    // Create notification
    try {
      const Notification = require("../models/Notification");
      const Client = require("../models/Client");
      const client = await Client.findById(carousel.client_id).lean();
      await Notification.create({
        account_id: carousel.account_id,
        type: "general",
        title: "Posted to Instagram",
        message: `Carousel for ${client?.name || "Unknown"} published to Instagram`,
        client_id: carousel.client_id,
        carousel_id: carousel._id,
      });
    } catch (notifErr) {
      logger.error("Failed to create publish notification:", notifErr);
    }

    res.json({ success: true, ...result });
  } catch (err) {
    logger.error("Failed to publish to Instagram:", err);
    res.status(400).json({ error: err.message || "Failed to publish to Instagram" });
  }
});

// POST /api/carousels/:id/slides/:position/rerender — re-render a single slide with new composition
router.post("/:id/slides/:position/rerender", async (req, res) => {
  try {
    const { composition, image_id, extra_image_ids } = req.body;
    const position = parseInt(req.params.position, 10);
    if (isNaN(position)) return res.status(400).json({ error: "Invalid position" });

    const carousel = await findOwnedDoc(Carousel, req, req.params.id);
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });

    const slideIndex = carousel.slides.findIndex((s) => s.position === position);
    if (slideIndex === -1) return res.status(404).json({ error: "Slide not found" });

    const slide = carousel.slides[slideIndex];

    // Update composition if provided
    if (composition) slide.composition = composition;

    // Update primary image if provided
    if (image_id) {
      const ClientImage = require("../models/ClientImage");
      const img = await ClientImage.findById(image_id);
      if (img) {
        slide.image_id = img._id;
        slide.image_key = img.storage_key;
      }
    }

    // Update extra images if provided
    if (extra_image_ids && Array.isArray(extra_image_ids)) {
      const ClientImage = require("../models/ClientImage");
      const imgs = await ClientImage.find({ _id: { $in: extra_image_ids } });
      slide.extra_image_ids = imgs.map((i) => i._id);
      slide.extra_image_keys = imgs.map((i) => i.storage_key);
    }

    // Build image selections for this single slide
    const imageSelections = [{
      position: slide.position,
      image_key: slide.image_key || null,
      image_id: slide.image_id || null,
      extra_image_keys: slide.extra_image_keys || [],
    }];

    // For outreach carousels, use inferred brand from prospect profile
    let brandKitOverride = null;
    if (carousel.is_outreach && carousel.prospect_profile_id) {
      const ProspectProfile = require("../models/ProspectProfile");
      const prospect = await ProspectProfile.findById(carousel.prospect_profile_id).select("inferred_brand profile.name ig_handle").lean();
      if (prospect) {
        brandKitOverride = {
          primary_color: prospect.inferred_brand?.primary_color || "#000000",
          secondary_color: prospect.inferred_brand?.secondary_color || "#ffffff",
          accent_color: prospect.inferred_brand?.accent_color || "#3b82f6",
          font_heading: "Playfair Display",
          font_body: "DM Sans",
          name: prospect.profile?.name || prospect.ig_handle,
        };
      }
    }

    const { renderSlides } = require("../services/carousel/slideRenderer");
    const rendered = await renderSlides({
      carouselId: carousel._id.toString(),
      clientId: carousel.client_id.toString(),
      accountId: carousel.account_id.toString(),
      slides: [slide],
      imageSelections,
      templateId: carousel.template_id?.toString(),
      lutId: carousel.lut_id?.toString() || null,
      ...(brandKitOverride ? { showBrandName: false, brandKitOverride } : {}),
    });

    // Update just this slide in the carousel
    const r = rendered[0];
    if (r) slide.rendered_key = r.rendered_key;

    carousel.slides[slideIndex] = slide;
    await carousel.save();

    res.json(carousel);
  } catch (err) {
    logger.error("Failed to re-render slide:", err);
    res.status(500).json({ error: "Failed to re-render slide" });
  }
});

// POST /api/carousels/:id/chat-edit — conversational slide editing via AI (copy + image swaps)
router.post("/:id/chat-edit", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    const carousel = await findOwnedDoc(Carousel, req, req.params.id);
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });
    if (!carousel.slides || carousel.slides.length === 0) {
      return res.status(400).json({ error: "Carousel has no slides" });
    }

    const Anthropic = require("@anthropic-ai/sdk").default;
    const Account = require("../models/Account");
    const ClientImage = require("../models/ClientImage");

    // Read the Claude key from the carousel's owning account, not req.account
    // (which for role=2 is the user's empty isolated account).
    const account = await Account.findById(carousel.account_id);
    const token = account?.claude_token
      ? Account.decryptField(account.claude_token)
      : process.env.CLAUDE;
    if (!token) return res.status(500).json({ error: "No Claude token available" });

    const claude = new Anthropic({ apiKey: token });

    // ── Build slide context (current copy + which image is on each slide) ──
    const currentImageIds = new Set(
      carousel.slides.filter((s) => s.image_id).map((s) => s.image_id.toString()),
    );
    const currentImages = await ClientImage.find({
      _id: { $in: [...currentImageIds] },
    }).select("summary tags").lean();
    const currentImageById = new Map(currentImages.map((i) => [i._id.toString(), i]));

    const slideContext = carousel.slides
      .map((s) => {
        const img = s.image_id ? currentImageById.get(s.image_id.toString()) : null;
        const imgDesc = img
          ? `image: ${img._id} — "${img.summary || "(no summary)"}"`
          : s.composition === "text_only"
            ? "image: none (text-only slide)"
            : "image: none";
        return `Slide ${s.position} [${s.role}, ${s.composition}]\n  copy: "${s.copy}"\n  ${imgDesc}`;
      })
      .join("\n\n");

    // ── Build image library context (top candidates the AI can swap to) ──
    // client_id alone is sufficient — every ClientImage belongs to exactly one Client.
    const libraryImages = await ClientImage.find({
      client_id: carousel.client_id,
      status: "ready",
    })
      .select("summary tags quality_score is_portrait suitable_as_cover")
      .sort({ quality_score: -1 })
      .limit(60)
      .lean();

    const libraryContext = libraryImages.length === 0
      ? "(no images in library)"
      : libraryImages
        .map((img) => {
          const tagBits = [];
          if (img.tags?.emotion?.length) tagBits.push(`emotion: ${img.tags.emotion.join("/")}`);
          if (img.tags?.vibe?.length) tagBits.push(`vibe: ${img.tags.vibe.join("/")}`);
          if (img.tags?.setting?.length) tagBits.push(`setting: ${img.tags.setting.join("/")}`);
          const flags = [
            img.is_portrait ? "portrait" : "landscape",
            img.suitable_as_cover ? "cover-ok" : null,
          ].filter(Boolean).join(", ");
          return `- ${img._id} [${flags}] "${img.summary || "(no summary)"}"${tagBits.length ? ` | ${tagBits.join(" · ")}` : ""}`;
        })
        .join("\n");

    // ── Tools the AI can call ──
    const tools = [
      {
        name: "update_slide_copy",
        description: "Replace the text copy on a specific slide. Use this when the user wants to change wording, tone, length, or messaging.",
        input_schema: {
          type: "object",
          properties: {
            position: { type: "integer", description: "Slide position (1-indexed)" },
            new_copy: { type: "string", description: "The new copy text for the slide" },
          },
          required: ["position", "new_copy"],
        },
      },
      {
        name: "swap_slide_image",
        description: "Replace the image on a specific slide with a different image from the client's library. Use this when the user asks to change the photo, swap the image, use a different picture, etc. Pick the image from the library that best matches the slide's role and the user's instruction.",
        input_schema: {
          type: "object",
          properties: {
            position: { type: "integer", description: "Slide position (1-indexed)" },
            image_id: { type: "string", description: "MongoDB ObjectId of the image from the library to use" },
            reason: { type: "string", description: "Brief explanation of why this image fits" },
          },
          required: ["position", "image_id"],
        },
      },
    ];

    const systemPrompt = `You are an editor for an Instagram carousel. The user will ask you to modify slides — either the text copy, or which photo is shown, or both. Use the provided tools to apply changes.

Guidelines:
- Use "update_slide_copy" for any text/wording change. Keep tone consistent with existing copy. Be punchy — carousel text is short.
- Use "swap_slide_image" when the user wants a different photo. Pick from the LIBRARY only — never invent image IDs. Match the slide's role and the user's intent (mood, setting, vibe).
- You may call multiple tools in one response (e.g. swap two images, edit one copy).
- If the user gives a general instruction ("make it punchier"), apply it to all relevant slides.
- If the request is unclear or impossible (e.g. asking for an image that doesn't exist in the library), respond with text only — no tool calls — explaining what you'd need.
- After your tool calls, you may include a brief text message confirming what you changed.`;

    const userMessage = `CURRENT CAROUSEL (${carousel.slides.length} slides):
${slideContext}

AVAILABLE IMAGE LIBRARY (${libraryImages.length} images, sorted by quality):
${libraryContext}

USER INSTRUCTION: ${message}`;

    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      temperature: 0.4,
      tools,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    // ── Process tool_use blocks + collect text reply ──
    const copyUpdates = [];
    const imageSwaps = [];
    const textParts = [];

    for (const block of response.content || []) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        if (block.name === "update_slide_copy") {
          const { position, new_copy } = block.input || {};
          if (typeof position === "number" && typeof new_copy === "string") {
            copyUpdates.push({ position, copy: new_copy });
          }
        } else if (block.name === "swap_slide_image") {
          const { position, image_id, reason } = block.input || {};
          if (typeof position === "number" && typeof image_id === "string") {
            imageSwaps.push({ position, image_id, reason: reason || "" });
          }
        }
      }
    }

    // ── Apply copy updates ──
    for (const update of copyUpdates) {
      const idx = carousel.slides.findIndex((s) => s.position === update.position);
      if (idx !== -1) carousel.slides[idx].copy = update.copy;
    }

    // ── Apply image swaps (validate IDs exist in this client's library) ──
    const validSwapIds = imageSwaps.length > 0
      ? await ClientImage.find({
        _id: { $in: imageSwaps.map((s) => s.image_id) },
        client_id: carousel.client_id,
        status: "ready",
      }).select("_id storage_key thumbnail_key").lean()
      : [];
    const validSwapById = new Map(validSwapIds.map((i) => [i._id.toString(), i]));

    const appliedSwaps = [];
    for (const swap of imageSwaps) {
      const img = validSwapById.get(swap.image_id);
      if (!img) continue;
      const idx = carousel.slides.findIndex((s) => s.position === swap.position);
      if (idx === -1) continue;
      carousel.slides[idx].image_id = img._id;
      carousel.slides[idx].image_key = img.storage_key;
      carousel.slides[idx].is_ai_generated_image = false;
      if (swap.reason) carousel.slides[idx].image_selection_reason = swap.reason;
      appliedSwaps.push(swap);
    }

    const changedPositions = new Set([
      ...copyUpdates.map((u) => u.position),
      ...appliedSwaps.map((s) => s.position),
    ]);

    if (changedPositions.size > 0) {
      await carousel.save();

      // ── Re-render every changed slide ──
      try {
        const { renderSlides } = require("../services/carousel/slideRenderer");
        const slidesToRender = carousel.slides.filter((s) => changedPositions.has(s.position));

        const imageSelections = slidesToRender.map((s) => ({
          position: s.position,
          image_key: s.image_key || null,
          image_id: s.image_id || null,
          extra_image_keys: s.extra_image_keys || [],
        }));

        const rendered = await renderSlides({
          carouselId: carousel._id.toString(),
          clientId: carousel.client_id.toString(),
          accountId: carousel.account_id.toString(),
          slides: slidesToRender,
          imageSelections,
          templateId: carousel.template_id?.toString(),
          lutId: carousel.lut_id?.toString() || null,
        });

        for (const r of rendered) {
          const idx = carousel.slides.findIndex((s) => s.position === r.position);
          if (idx !== -1) carousel.slides[idx].rendered_key = r.rendered_key;
        }
        await carousel.save();
      } catch (renderErr) {
        logger.error("Failed to re-render slides after chat edit:", renderErr);
        // Non-fatal — DB state is already updated
      }
    }

    // ── Build assistant message ──
    let assistantMessage = textParts.join("\n").trim();
    if (!assistantMessage) {
      const parts = [];
      if (copyUpdates.length > 0) {
        parts.push(`Updated copy on slide${copyUpdates.length > 1 ? "s" : ""} ${copyUpdates.map((u) => u.position).sort().join(", ")}.`);
      }
      if (appliedSwaps.length > 0) {
        parts.push(`Swapped image${appliedSwaps.length > 1 ? "s" : ""} on slide${appliedSwaps.length > 1 ? "s" : ""} ${appliedSwaps.map((s) => s.position).sort().join(", ")}.`);
      }
      assistantMessage = parts.length > 0
        ? parts.join(" ")
        : "I couldn't make a change for that — try being more specific about which slide or what to change.";
    }

    const updated = await Carousel.findById(carousel._id);
    const withUrls = await attachSlideUrls(updated);
    res.json({
      carousel: withUrls,
      updated_slides: copyUpdates,
      swapped_images: appliedSwaps,
      assistant_message: assistantMessage,
    });
  } catch (err) {
    logger.error("Failed to chat-edit carousel:", err);
    res.status(500).json({ error: "Failed to process edit instruction" });
  }
});

// DELETE /api/carousels/:id
router.delete("/:id", async (req, res) => {
  try {
    const existing = await findOwnedDoc(Carousel, req, req.params.id);
    if (!existing) return res.status(404).json({ error: "Carousel not found" });
    await Carousel.deleteOne({ _id: existing._id });
    await CarouselJob.deleteMany({ carousel_id: existing._id });
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete carousel:", err);
    res.status(500).json({ error: "Failed to delete carousel" });
  }
});

module.exports = router;

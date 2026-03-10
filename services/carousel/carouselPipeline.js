const Carousel = require("../../models/Carousel");
const CarouselJob = require("../../models/CarouselJob");
const Client = require("../../models/Client");
const SwipeFile = require("../../models/SwipeFile");
const { generateCopy } = require("./copyGenerator");
const { selectImages, trackImageUsage } = require("./imageSelector");
const { generateMissingImages } = require("./imageGenerator");
const { renderSlides } = require("./slideRenderer");
const { scoreCarousel } = require("./confidenceScorer");
const logger = require("../../utils/logger").child({ module: "carouselPipeline" });

/**
 * Update job status + progress and emit socket event if available.
 */
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
 * Run the full carousel generation pipeline.
 *
 * @param {Object} opts
 * @param {string} opts.carouselId - Carousel document ID
 * @param {string} opts.jobId - CarouselJob document ID
 * @param {Object} [opts.io] - Socket.IO instance for real-time updates
 * @param {string} [opts.copyModel] - AI model for copy generation
 */
async function runPipeline({ carouselId, jobId, io, copyModel, lutId, stylePrompt }) {
  const carousel = await Carousel.findById(carouselId);
  if (!carousel) throw new Error(`Carousel ${carouselId} not found`);

  const log = [];
  const pushLog = (msg) => {
    log.push(`[${new Date().toISOString()}] ${msg}`);
    logger.info(msg);
  };

  try {
    // Mark as generating
    await Carousel.findByIdAndUpdate(carouselId, { status: "generating" });
    await CarouselJob.findByIdAndUpdate(jobId, { status: "analyzing_transcripts", started_at: new Date() });

    // ──────────────────────────────────────────────
    // Step 1: Generate copy (includes transcript analysis + angle extraction)
    // ──────────────────────────────────────────────
    await updateJobStatus(jobId, "generating_copy", 10, io);
    pushLog("Generating carousel copy...");

    const copyResult = await generateCopy({
      accountId: carousel.account_id.toString(),
      clientId: carousel.client_id.toString(),
      transcriptIds: carousel.transcript_ids.map((id) => id.toString()),
      goal: carousel.goal,
      swipeFileId: carousel.swipe_file_id?.toString(),
      templateId: carousel.template_id?.toString(),
      copyModel: copyModel || "claude-sonnet",
      stylePrompt: stylePrompt || null,
    });

    pushLog(`Generated ${copyResult.slides.length} slides of copy`);

    // Save copy to carousel
    const slidesDocs = copyResult.slides.map((s) => ({
      position: s.position,
      role: s.role,
      composition: s.composition || "single_hero",
      copy: s.copy,
      copy_why: s.why || "",
    }));

    await Carousel.findByIdAndUpdate(carouselId, {
      slides: slidesDocs,
      caption: copyResult.caption,
      hashtags: copyResult.hashtags,
      angle: copyResult.angle || {},
      strategy_notes: copyResult.strategy_notes || "",
    });

    // ──────────────────────────────────────────────
    // Step 2: Select images from library
    // ──────────────────────────────────────────────
    await updateJobStatus(jobId, "selecting_images", 35, io);
    pushLog("Selecting images from library...");

    let imageSelections = await selectImages({
      clientId: carousel.client_id.toString(),
      accountId: carousel.account_id.toString(),
      slides: copyResult.slides,
      goal: carousel.goal,
    });

    const matched = imageSelections.filter((s) => !s.needs_ai_image).length;
    pushLog(`Matched ${matched}/${copyResult.slides.length} slides with existing images`);

    // ──────────────────────────────────────────────
    // Step 3: Generate AI images for unmatched slides
    // ──────────────────────────────────────────────
    const needsAI = imageSelections.filter((s) => s.needs_ai_image).length;
    if (needsAI > 0) {
      await updateJobStatus(jobId, "generating_images", 50, io);
      pushLog(`Generating ${needsAI} AI images...`);

      imageSelections = await generateMissingImages({
        accountId: carousel.account_id.toString(),
        clientId: carousel.client_id.toString(),
        slides: copyResult.slides,
        imageSelections,
        goal: carousel.goal,
      });

      const generated = needsAI - imageSelections.filter((s) => s.needs_ai_image).length;
      pushLog(`Generated ${generated} AI images`);
    } else {
      pushLog("All slides matched with existing images — no AI generation needed");
    }

    // Update slides with image references
    const updatedSlides = slidesDocs.map((slide) => {
      const sel = imageSelections.find((s) => s.position === slide.position);
      return {
        ...slide,
        image_id: sel?.image_id || null,
        image_key: sel?.image_key || null,
        is_ai_generated_image: sel?.is_ai_generated || false,
        image_selection_reason: sel?.image_selection_reason || "",
      };
    });

    await Carousel.findByIdAndUpdate(carouselId, { slides: updatedSlides });

    // ──────────────────────────────────────────────
    // Step 4: Render slides to PNG
    // ──────────────────────────────────────────────
    await updateJobStatus(jobId, "rendering_slides", 70, io);
    pushLog("Rendering slides to PNG...");

    const rendered = await renderSlides({
      carouselId: carouselId.toString(),
      clientId: carousel.client_id.toString(),
      accountId: carousel.account_id.toString(),
      slides: copyResult.slides,
      imageSelections,
      templateId: carousel.template_id?.toString(),
      lutId: lutId || carousel.lut_id?.toString() || null,
    });

    // Update slides with rendered keys
    const finalSlides = updatedSlides.map((slide) => {
      const r = rendered.find((rr) => rr.position === slide.position);
      return {
        ...slide,
        rendered_key: r?.rendered_key || null,
      };
    });

    await Carousel.findByIdAndUpdate(carouselId, { slides: finalSlides });
    pushLog(`Rendered ${rendered.length} slide PNGs`);

    // ──────────────────────────────────────────────
    // Step 5: Score confidence
    // ──────────────────────────────────────────────
    await updateJobStatus(jobId, "scoring", 90, io);
    pushLog("Scoring carousel confidence...");

    const client = await Client.findById(carousel.client_id);
    const swipeFile = carousel.swipe_file_id ? await SwipeFile.findById(carousel.swipe_file_id) : null;

    const confidence = await scoreCarousel({
      slides: copyResult.slides,
      imageSelections,
      transcriptIds: carousel.transcript_ids.map((id) => id.toString()),
      angle: copyResult.angle,
      goal: carousel.goal,
      voiceProfile: client?.voice_profile || {},
      ctaDefaults: client?.cta_defaults || {},
      swipeFile,
    });

    // ──────────────────────────────────────────────
    // Finalize
    // ──────────────────────────────────────────────
    await Carousel.findByIdAndUpdate(carouselId, {
      confidence,
      status: "ready",
      generation_log: log,
    });

    // Track image usage
    await trackImageUsage(imageSelections, carouselId);

    await updateJobStatus(jobId, "completed", 100, io);
    await CarouselJob.findByIdAndUpdate(jobId, { status: "completed" });

    pushLog(`Carousel ${carouselId} complete — confidence: ${confidence.overall}/100`);

    return { carouselId, confidence };
  } catch (err) {
    logger.error(`Pipeline failed for carousel ${carouselId}:`, err);

    await Carousel.findByIdAndUpdate(carouselId, {
      status: "failed",
      generation_log: [...log, `[${new Date().toISOString()}] ERROR: ${err.message}`],
    });

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

module.exports = { runPipeline };

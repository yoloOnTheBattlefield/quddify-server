const express = require("express");
const router = express.Router();
const Carousel = require("../models/Carousel");
const CarouselJob = require("../models/CarouselJob");
const validate = require("../middleware/validate");
const carouselSchemas = require("../schemas/carousels");
const logger = require("../utils/logger").child({ module: "carousels" });

// GET /api/carousels?client_id=xxx
router.get("/", async (req, res) => {
  try {
    const filter = { account_id: req.account._id };
    if (req.query.client_id) filter.client_id = req.query.client_id;
    if (req.query.status) filter.status = req.query.status;
    const carousels = await Carousel.find(filter).sort({ created_at: -1 }).limit(50);
    res.json(carousels);
  } catch (err) {
    logger.error("Failed to list carousels:", err);
    res.status(500).json({ error: "Failed to list carousels" });
  }
});

// GET /api/carousels/:id
router.get("/:id", async (req, res) => {
  try {
    const carousel = await Carousel.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });
    res.json(carousel);
  } catch (err) {
    logger.error("Failed to get carousel:", err);
    res.status(500).json({ error: "Failed to get carousel" });
  }
});

// POST /api/carousels/generate — kick off carousel generation
router.post("/generate", validate(carouselSchemas.generate), async (req, res) => {
  try {
    const { client_id, transcript_ids, swipe_file_id, template_id, goal, copy_model, lut_id, style_id, style_prompt_override, layout_preset } = req.body;

    // Resolve style prompt from saved preset or override
    let stylePrompt = style_prompt_override || "";
    if (style_id && !stylePrompt) {
      const CarouselStyle = require("../models/CarouselStyle");
      const style = await CarouselStyle.findById(style_id);
      if (style) stylePrompt = style.style_prompt;
    }

    const carousel = await Carousel.create({
      client_id,
      account_id: req.account._id,
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
      account_id: req.account._id,
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

// GET /api/carousels/:id/job — get job status for a carousel
router.get("/:id/job", async (req, res) => {
  try {
    const job = await CarouselJob.findOne({ carousel_id: req.params.id, account_id: req.account._id }).sort({ created_at: -1 });
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
    const carousel = await Carousel.findOneAndUpdate(
      { _id: req.params.id, account_id: req.account._id },
      { $set: req.body },
      { new: true },
    );
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });
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

    const carousel = await Carousel.findOne({ _id: req.params.id, account_id: req.account._id });
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
    const carousel = await Carousel.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });

    // Reset carousel status
    await Carousel.findByIdAndUpdate(carousel._id, { status: "queued" });

    const job = await CarouselJob.create({
      carousel_id: carousel._id,
      account_id: req.account._id,
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
    const carousel = await Carousel.findOne({ _id: req.params.id, account_id: req.account._id });
    if (!carousel) return res.status(404).json({ error: "Carousel not found" });

    const { publishToInstagram } = require("../services/carousel/igPublisher");
    const result = await publishToInstagram({
      carouselId: carousel._id.toString(),
      accountId: req.account._id.toString(),
    });

    // Create notification
    try {
      const Notification = require("../models/Notification");
      const Client = require("../models/Client");
      const client = await Client.findById(carousel.client_id).lean();
      await Notification.create({
        account_id: req.account._id,
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

    const carousel = await Carousel.findOne({ _id: req.params.id, account_id: req.account._id });
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

    const { renderSlides } = require("../services/carousel/slideRenderer");
    const rendered = await renderSlides({
      carouselId: carousel._id.toString(),
      clientId: carousel.client_id.toString(),
      accountId: carousel.account_id.toString(),
      slides: [slide],
      imageSelections,
      templateId: carousel.template_id?.toString(),
      lutId: carousel.lut_id?.toString() || null,
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

// DELETE /api/carousels/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await Carousel.findOneAndDelete({ _id: req.params.id, account_id: req.account._id });
    if (!result) return res.status(404).json({ error: "Carousel not found" });
    await CarouselJob.deleteMany({ carousel_id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete carousel:", err);
    res.status(500).json({ error: "Failed to delete carousel" });
  }
});

module.exports = router;

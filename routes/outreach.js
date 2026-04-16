const express = require("express");
const router = express.Router();
const ProspectProfile = require("../models/ProspectProfile");
const ClientImage = require("../models/ClientImage");
const Carousel = require("../models/Carousel");
const CarouselJob = require("../models/CarouselJob");
const validate = require("../middleware/validate");
const outreachSchemas = require("../schemas/outreach");
const { loadOwnedClient } = require("../utils/clientUserScope");
const { getPresignedUrl } = require("../services/storageService");
const logger = require("../utils/logger").child({ module: "outreach" });

// GET /api/outreach — List recent prospect profiles
router.get("/", async (req, res) => {
  try {
    const profiles = await ProspectProfile.find({ account_id: req.account._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("ig_handle ig_profile_picture_url ig_followers_count status current_step progress error profile.name profile.niche generation_time_ms createdAt")
      .lean();

    res.json(profiles);
  } catch (err) {
    logger.error("Failed to list prospect profiles:", err);
    res.status(500).json({ error: "Failed to list profiles" });
  }
});

// POST /api/outreach/scrape — Start scraping a prospect's IG content
router.post("/scrape", validate(outreachSchemas.scrape), async (req, res) => {
  try {
    const { ig_handle, client_id, direct_urls } = req.body;

    const client = await loadOwnedClient(req, client_id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const handle = ig_handle.replace(/^@/, "").trim();

    const profile = await ProspectProfile.create({
      account_id: client.account_id,
      client_id,
      ig_handle: handle,
      status: "scraping",
      scrape_started_at: new Date(),
    });

    // Run scraping + profiling in background
    const { scrapeProspectContent } = require("../services/prospectScraper");
    const { generateProspectProfile } = require("../services/prospectProfiler");

    (async () => {
      try {
        await scrapeProspectContent(profile._id.toString(), client.account_id.toString(), direct_urls);
        await generateProspectProfile(profile._id.toString(), client.account_id.toString());
      } catch (err) {
        logger.error(`Background scrape+profile failed for @${handle}:`, err);
      }
    })();

    res.status(201).json({ profile_id: profile._id, status: "scraping" });
  } catch (err) {
    logger.error("Failed to start outreach scrape:", err);
    res.status(500).json({ error: err.message || "Failed to start scraping" });
  }
});

// GET /api/outreach/:profileId — Get prospect profile
router.get("/:profileId", async (req, res) => {
  try {
    const profile = await ProspectProfile.findOne({
      _id: req.params.profileId,
      account_id: req.account._id,
    }).lean();

    if (!profile) return res.status(404).json({ error: "Profile not found" });

    // Attach profile picture presigned URL if available
    if (profile.ig_profile_picture_url) {
      profile.ig_profile_picture_display_url = profile.ig_profile_picture_url;
    }

    res.json(profile);
  } catch (err) {
    logger.error("Failed to get prospect profile:", err);
    res.status(500).json({ error: "Failed to get profile" });
  }
});

// GET /api/outreach/:profileId/images — Get tagged prospect images
router.get("/:profileId/images", async (req, res) => {
  try {
    const profile = await ProspectProfile.findOne({
      _id: req.params.profileId,
      account_id: req.account._id,
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    const images = await ClientImage.find({
      prospect_profile_id: req.params.profileId,
      status: { $in: ["ready", "processing"] },
    })
      .sort({ quality_score: -1 })
      .lean();

    // Attach presigned URLs
    const withUrls = await Promise.all(
      images.map(async (img) => ({
        ...img,
        url: await getPresignedUrl(img.storage_key, 3600),
        thumbnail_url: img.thumbnail_key ? await getPresignedUrl(img.thumbnail_key, 3600) : null,
      })),
    );

    res.json(withUrls);
  } catch (err) {
    logger.error("Failed to get prospect images:", err);
    res.status(500).json({ error: "Failed to get images" });
  }
});

// PUT /api/outreach/:profileId/profile — Edit AI-generated profile
router.put("/:profileId/profile", validate(outreachSchemas.updateProfile), async (req, res) => {
  try {
    const profile = await ProspectProfile.findOne({
      _id: req.params.profileId,
      account_id: req.account._id,
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    const updates = {};

    if (req.body.profile) {
      for (const [key, value] of Object.entries(req.body.profile)) {
        if (value !== undefined) {
          if (key === "cta_style") {
            // Merge CTA style fields
            for (const [ctaKey, ctaVal] of Object.entries(value)) {
              if (ctaVal !== undefined) {
                updates[`profile.cta_style.${ctaKey}`] = ctaVal;
              }
            }
          } else {
            updates[`profile.${key}`] = value;
          }
        }
      }
    }

    if (req.body.inferred_brand) {
      for (const [key, value] of Object.entries(req.body.inferred_brand)) {
        if (value !== undefined) {
          updates[`inferred_brand.${key}`] = value;
        }
      }
    }

    const updated = await ProspectProfile.findByIdAndUpdate(
      req.params.profileId,
      { $set: updates },
      { new: true },
    ).lean();

    res.json(updated);
  } catch (err) {
    logger.error("Failed to update prospect profile:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// POST /api/outreach/:profileId/generate — Generate outreach carousel
router.post("/:profileId/generate", validate(outreachSchemas.generate), async (req, res) => {
  try {
    logger.info(`Generate request: profileId=${req.params.profileId}, account=${req.account?._id}, body=${JSON.stringify(req.body)}`);
    const profile = await ProspectProfile.findOne({
      _id: req.params.profileId,
      account_id: req.account._id,
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    if (profile.status !== "ready") {
      return res.status(400).json({ error: `Profile is not ready (status: ${profile.status})` });
    }

    const { topic, goal, slide_count, additional_instructions } = req.body;

    // Use the prospect's top content angle as default topic
    const carouselTopic = topic || profile.profile?.top_performing_angles?.[0]?.angle || profile.profile?.core_message || `Content for @${profile.ig_handle}`;

    const carousel = await Carousel.create({
      client_id: profile.client_id,
      account_id: profile.account_id,
      topic: carouselTopic,
      transcript_ids: [],
      goal: goal || "conversion_focused",
      status: "queued",
      prospect_profile_id: profile._id,
      is_outreach: true,
    });

    const job = await CarouselJob.create({
      carousel_id: carousel._id,
      account_id: profile.account_id,
      status: "queued",
    });

    // Run outreach pipeline in background
    const { runOutreachPipeline } = require("../services/carousel/outreachPipeline");
    runOutreachPipeline({
      carouselId: carousel._id.toString(),
      jobId: job._id.toString(),
      profileId: profile._id.toString(),
      io: req.app.get("io"),
      topic: carouselTopic,
      goal: goal || "conversion_focused",
      slideCount: slide_count || 7,
      additionalInstructions: additional_instructions || "",
    }).catch((err) => {
      logger.error("Background outreach pipeline failed:", err);
    });

    res.status(201).json({ carousel, job });
  } catch (err) {
    logger.error("Failed to generate outreach carousel:", err);
    res.status(500).json({ error: err.message || "Failed to generate carousel" });
  }
});

// POST /api/outreach/:profileId/retry — Re-run profiling on a failed profile (without re-scraping)
router.post("/:profileId/retry", async (req, res) => {
  try {
    const profile = await ProspectProfile.findOne({
      _id: req.params.profileId,
      account_id: req.account._id,
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    if (profile.status !== "failed") {
      return res.status(400).json({ error: `Cannot retry — status is ${profile.status}` });
    }

    await ProspectProfile.findByIdAndUpdate(profile._id, {
      status: "profiling",
      current_step: "profiling",
      progress: 92,
      error: null,
    });

    const { generateProspectProfile } = require("../services/prospectProfiler");
    generateProspectProfile(profile._id.toString(), profile.account_id.toString()).catch((err) => {
      logger.error(`Retry profiling failed for @${profile.ig_handle}:`, err);
    });

    res.json({ success: true, status: "profiling" });
  } catch (err) {
    logger.error("Failed to retry profiling:", err);
    res.status(500).json({ error: err.message || "Failed to retry" });
  }
});

// POST /api/outreach/:profileId/cancel — Cancel an in-progress scrape
router.post("/:profileId/cancel", async (req, res) => {
  try {
    const profile = await ProspectProfile.findOne({
      _id: req.params.profileId,
      account_id: req.account._id,
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    if (profile.status !== "scraping" && profile.status !== "profiling") {
      return res.status(400).json({ error: `Cannot cancel — status is ${profile.status}` });
    }

    const { cancelScrapeJob } = require("../services/prospectScraper");
    const cancelled = cancelScrapeJob(profile._id.toString());

    if (!cancelled) {
      // Job not in memory (maybe already finished) — just mark as failed
      await ProspectProfile.findByIdAndUpdate(profile._id, {
        status: "failed",
        error: "Cancelled",
        current_step: "cancelled",
      });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to cancel scrape:", err);
    res.status(500).json({ error: "Failed to cancel" });
  }
});

// DELETE /api/outreach/:profileId — Clean up prospect data
router.delete("/:profileId", async (req, res) => {
  try {
    const profile = await ProspectProfile.findOne({
      _id: req.params.profileId,
      account_id: req.account._id,
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    // Delete prospect images from storage and DB
    const { remove } = require("../services/storageService");
    const images = await ClientImage.find({ prospect_profile_id: profile._id });

    for (const img of images) {
      try {
        await remove(img.storage_key);
      } catch {
        // best-effort
      }
    }
    await ClientImage.deleteMany({ prospect_profile_id: profile._id });

    await ProspectProfile.findByIdAndDelete(profile._id);

    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete prospect profile:", err);
    res.status(500).json({ error: "Failed to delete profile" });
  }
});

module.exports = router;

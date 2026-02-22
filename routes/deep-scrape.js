const express = require("express");
const mongoose = require("mongoose");
const DeepScrapeJob = require("../models/DeepScrapeJob");
const ApifyToken = require("../models/ApifyToken");
const OutboundLead = require("../models/OutboundLead");
const ResearchPost = require("../models/ResearchPost");
const ResearchComment = require("../models/ResearchComment");
const Prompt = require("../models/Prompt");
const deepScraper = require("../services/deepScraper");

const router = express.Router();

// POST /api/deep-scrape/start
router.post("/start", async (req, res) => {
  try {
    const {
      name,
      seed_usernames,
      reel_limit,
      comment_limit,
      min_followers,
      force_reprocess,
      prompt_id,
      is_recurring,
      repeat_interval_days,
    } = req.body;

    if (
      !seed_usernames ||
      !Array.isArray(seed_usernames) ||
      seed_usernames.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "seed_usernames is required (array of usernames)" });
    }

    // Validate Apify token (multi-token or legacy)
    const hasTokens = await ApifyToken.countDocuments({
      account_id: req.account._id,
      status: "active",
    });
    if (!hasTokens && !req.account.apify_token) {
      return res.status(400).json({
        error:
          "No Apify tokens configured. Add tokens in Integrations before starting a deep scrape.",
      });
    }

    // Clean usernames
    const cleaned = seed_usernames
      .map((u) => u.replace(/^@/, "").trim())
      .filter(Boolean);

    if (cleaned.length === 0) {
      return res.status(400).json({ error: "No valid usernames provided" });
    }

    // Resolve prompt
    let promptLabel = null;
    if (prompt_id) {
      if (!mongoose.Types.ObjectId.isValid(prompt_id)) {
        return res.status(400).json({ error: "Invalid prompt_id" });
      }
      const prompt = await Prompt.findById(prompt_id).lean();
      if (!prompt) {
        return res.status(404).json({ error: "Prompt not found" });
      }
      promptLabel = prompt.label;
    }

    const job = await DeepScrapeJob.create({
      account_id: req.account._id,
      name: name?.trim() || null,
      seed_usernames: cleaned,
      reel_limit: reel_limit || 10,
      comment_limit: comment_limit || 100,
      min_followers: min_followers ?? 1000,
      force_reprocess: force_reprocess || false,
      promptId: prompt_id || null,
      promptLabel,
      is_recurring: is_recurring || false,
      repeat_interval_days: is_recurring ? (repeat_interval_days || 3) : null,
    });

    // Start in background
    deepScraper.processJob(job._id.toString());

    res.status(201).json({ jobId: job._id, status: job.status });
  } catch (err) {
    console.error("Deep scrape start error:", err);
    res.status(500).json({ error: "Failed to start deep scrape job" });
  }
});

// GET /api/deep-scrape
router.get("/", async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const filter = { account_id: req.account._id };
    if (status) filter.status = status;

    const [jobs, total] = await Promise.all([
      DeepScrapeJob.find(filter)
        .select("-reel_urls -reel_seeds -commenter_usernames -commenter_seed_map")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      DeepScrapeJob.countDocuments(filter),
    ]);

    res.json({
      jobs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to list jobs" });
  }
});

// GET /api/deep-scrape/target-stats
router.get("/target-stats", async (req, res) => {
  try {
    const stats = await OutboundLead.aggregate([
      {
        $match: {
          account_id: req.account._id,
          source_seeds: { $exists: true, $ne: [] },
        },
      },
      { $unwind: "$source_seeds" },
      {
        $group: {
          _id: "$source_seeds",
          total_scraped: { $sum: 1 },
          avg_followers: { $avg: { $ifNull: ["$followersCount", 0] } },
          qualified: {
            $sum: { $cond: [{ $eq: ["$qualified", true] }, 1, 0] },
          },
          rejected: {
            $sum: {
              $cond: [
                { $eq: ["$unqualified_reason", "ai_rejected"] },
                1,
                0,
              ],
            },
          },
          low_followers: {
            $sum: {
              $cond: [
                { $eq: ["$unqualified_reason", "low_followers"] },
                1,
                0,
              ],
            },
          },
          messaged: {
            $sum: { $cond: [{ $eq: ["$isMessaged", true] }, 1, 0] },
          },
          replied: {
            $sum: { $cond: [{ $eq: ["$replied", true] }, 1, 0] },
          },
          booked: {
            $sum: { $cond: [{ $eq: ["$booked", true] }, 1, 0] },
          },
          total_contract_value: {
            $sum: { $ifNull: ["$contract_value", 0] },
          },
        },
      },
      { $sort: { total_scraped: -1 } },
    ]);

    res.json({
      targets: stats.map((s) => ({
        seed: s._id,
        total_scraped: s.total_scraped,
        avg_followers: Math.round(s.avg_followers),
        qualified: s.qualified,
        rejected: s.rejected,
        low_followers: s.low_followers,
        messaged: s.messaged,
        replied: s.replied,
        booked: s.booked,
        total_contract_value: s.total_contract_value,
        reply_rate: s.messaged > 0 ? +(s.replied / s.messaged * 100).toFixed(1) : 0,
        book_rate: s.messaged > 0 ? +(s.booked / s.messaged * 100).toFixed(1) : 0,
      })),
    });
  } catch (err) {
    console.error("Target stats error:", err);
    res.status(500).json({ error: "Failed to compute target stats" });
  }
});

// GET /api/deep-scrape/:id
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const job = await DeepScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    })
      .select("-reel_urls -reel_seeds -commenter_usernames -commenter_seed_map")
      .lean();

    if (!job) return res.status(404).json({ error: "Job not found" });

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: "Failed to get job" });
  }
});

// GET /api/deep-scrape/:id/leads
router.get("/:id/leads", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const filter = {
      account_id: req.account._id,
      "metadata.executionId": `deep-scrape-${req.params.id}`,
    };

    const [leads, total] = await Promise.all([
      OutboundLead.find(filter)
        .select("username fullName followersCount bio qualified unqualified_reason createdAt")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      OutboundLead.countDocuments(filter),
    ]);

    res.json({
      leads,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch job leads" });
  }
});

// POST /api/deep-scrape/:id/pause
router.post("/:id/pause", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const job = await DeepScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    const activeStatuses = [
      "pending",
      "scraping_reels",
      "scraping_comments",
      "scraping_profiles",
      "qualifying",
    ];
    if (!activeStatuses.includes(job.status)) {
      return res
        .status(400)
        .json({ error: `Cannot pause job with status: ${job.status}` });
    }

    const paused = deepScraper.pauseJob(job._id.toString());
    if (!paused) {
      job.status = "paused";
      await job.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to pause job" });
  }
});

// POST /api/deep-scrape/:id/cancel
router.post("/:id/cancel", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const job = await DeepScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    const activeStatuses = [
      "pending",
      "scraping_reels",
      "scraping_comments",
      "scraping_profiles",
      "qualifying",
    ];
    if (!activeStatuses.includes(job.status)) {
      return res
        .status(400)
        .json({ error: `Cannot cancel job with status: ${job.status}` });
    }

    const cancelled = deepScraper.cancelJob(job._id.toString());
    if (!cancelled) {
      job.status = "cancelled";
      job.completed_at = new Date();
      await job.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to cancel job" });
  }
});

// POST /api/deep-scrape/:id/resume
router.post("/:id/resume", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const job = await DeepScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    if (!["failed", "cancelled", "paused"].includes(job.status)) {
      return res
        .status(400)
        .json({ error: `Cannot resume job with status: ${job.status}` });
    }

    const hasTokens = await ApifyToken.countDocuments({
      account_id: req.account._id,
      status: "active",
    });
    if (!hasTokens && !req.account.apify_token) {
      return res.status(400).json({
        error: "No Apify tokens available. Add or reset tokens in Integrations first.",
      });
    }

    job.status = "pending";
    job.error = null;
    await job.save();

    deepScraper.processJob(job._id.toString());

    res.json({ jobId: job._id, status: "resumed" });
  } catch (err) {
    res.status(500).json({ error: "Failed to resume job" });
  }
});

// POST /api/deep-scrape/:id/skip-comments
router.post("/:id/skip-comments", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const job = await DeepScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    if (!["scraping_comments", "scraping_profiles"].includes(job.status)) {
      return res
        .status(400)
        .json({ error: `Can only skip when status is scraping_comments or scraping_profiles, got: ${job.status}` });
    }

    const skipped = deepScraper.skipComments(job._id.toString());
    if (!skipped) {
      // Job not actively running in memory — set flag directly
      job.comments_skipped = true;
      job.status = "completed";
      job.completed_at = new Date();
      await job.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to skip comments" });
  }
});

// POST /api/deep-scrape/:id/resume-comments
router.post("/:id/resume-comments", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const job = await DeepScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    if (!job.comments_skipped) {
      return res.status(400).json({ error: "Comments were not skipped for this job" });
    }

    if (!["completed", "paused", "cancelled", "failed"].includes(job.status)) {
      return res
        .status(400)
        .json({ error: `Cannot resume comments for job with status: ${job.status}` });
    }

    const hasTokens = await ApifyToken.countDocuments({
      account_id: req.account._id,
      status: "active",
    });
    if (!hasTokens && !req.account.apify_token) {
      return res.status(400).json({
        error: "No Apify tokens available. Add or reset tokens in Integrations first.",
      });
    }

    job.comments_skipped = false;
    job.status = "pending";
    job.error = null;
    job.completed_at = null;
    await job.save();

    deepScraper.processJob(job._id.toString());

    res.json({ jobId: job._id, status: "resumed_comments" });
  } catch (err) {
    res.status(500).json({ error: "Failed to resume comments" });
  }
});

// DELETE /api/deep-scrape/:id
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const job = await DeepScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    const activeStatuses = [
      "pending",
      "scraping_reels",
      "scraping_comments",
      "scraping_profiles",
      "qualifying",
    ];
    if (activeStatuses.includes(job.status)) {
      return res
        .status(400)
        .json({ error: "Cannot delete an active job. Cancel it first." });
    }

    // Clean up associated research data
    await Promise.all([
      ResearchPost.deleteMany({ deep_scrape_job_id: job._id }),
      ResearchComment.deleteMany({ deep_scrape_job_id: job._id }),
      DeepScrapeJob.deleteOne({ _id: job._id }),
    ]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete job" });
  }
});

module.exports = router;

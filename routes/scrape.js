const express = require("express");
const mongoose = require("mongoose");
const ScrapeJob = require("../models/ScrapeJob");
const Prompt = require("../models/Prompt");
const instagramScraper = require("../services/instagramScraper");

const router = express.Router();

// Helper: get IG credentials from account, optionally by username
function getIgSession(account, igUsername) {
  // Check ig_sessions array first (multi-profile)
  if (account.ig_sessions && account.ig_sessions.length > 0) {
    let profile;
    if (igUsername) {
      profile = account.ig_sessions.find((s) => s.ig_username === igUsername);
    } else {
      // Default to first profile
      profile = account.ig_sessions[0];
    }
    if (profile && profile.session_id && profile.csrf_token && profile.ds_user_id) {
      return { session_id: profile.session_id, csrf_token: profile.csrf_token, ds_user_id: profile.ds_user_id };
    }
  }
  // Fallback to legacy ig_session
  const s = account.ig_session;
  if (!s || !s.session_id || !s.csrf_token || !s.ds_user_id) return null;
  return { session_id: s.session_id, csrf_token: s.csrf_token, ds_user_id: s.ds_user_id };
}

// POST /api/scrape/validate-session - Check if IG cookies are valid
router.post("/validate-session", async (req, res) => {
  try {
    const { ig_username } = req.body || {};
    const credentials = getIgSession(req.account, ig_username);
    if (!credentials) {
      return res.status(400).json({
        valid: false,
        error: "Instagram session not configured. Set credentials in account integrations first.",
      });
    }

    const result = await instagramScraper.validateSession(credentials);
    res.json(result);
  } catch (err) {
    console.error("Session validation error:", err);
    res.status(500).json({ valid: false, error: "Failed to validate session" });
  }
});

// POST /api/scrape/start - Start a new scrape job
router.post("/start", async (req, res) => {
  try {
    const { target_username, max_followers, prompt_id, ig_username } = req.body;

    if (!target_username) {
      return res.status(400).json({ error: "target_username is required" });
    }

    const credentials = getIgSession(req.account, ig_username);
    if (!credentials) {
      return res.status(400).json({
        error: "Instagram session not configured. Set credentials in account integrations first.",
      });
    }

    // Check for existing active job for this target
    const existing = await ScrapeJob.findOne({
      account_id: req.account._id,
      target_username: target_username.replace(/^@/, ""),
      status: { $in: ["pending", "collecting_followers", "fetching_bios"] },
    });

    if (existing) {
      return res.status(409).json({
        error: "A scrape job for this target is already running",
        jobId: existing._id,
      });
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

    const job = await ScrapeJob.create({
      account_id: req.account._id,
      target_username: target_username.replace(/^@/, ""),
      max_followers: max_followers || null,
      promptId: prompt_id || null,
      promptLabel,
    });

    // Start in background (pass credentials from account)
    instagramScraper.processJob(job._id.toString(), credentials);

    res.status(201).json({ jobId: job._id, status: job.status });
  } catch (err) {
    console.error("Scrape start error:", err);
    res.status(500).json({ error: "Failed to start scrape job" });
  }
});

// POST /api/scrape/:id/resume - Resume a failed/cancelled job
router.post("/:id/resume", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const { ig_username } = req.body || {};
    const credentials = getIgSession(req.account, ig_username);
    if (!credentials) {
      return res.status(400).json({
        error: "Instagram session not configured. Update credentials in account integrations first.",
      });
    }

    const job = await ScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    if (!["failed", "cancelled", "paused"].includes(job.status)) {
      return res
        .status(400)
        .json({ error: `Cannot resume job with status: ${job.status}` });
    }

    job.status = "pending";
    job.error = null;
    job.cancel_requested = false;
    await job.save();

    instagramScraper.processJob(job._id.toString(), credentials);

    res.json({ jobId: job._id, status: "resumed" });
  } catch (err) {
    console.error("Scrape resume error:", err);
    res.status(500).json({ error: "Failed to resume scrape job" });
  }
});

// GET /api/scrape - List all scrape jobs
router.get("/", async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const filter = { account_id: req.account._id };
    if (status) filter.status = status;

    const [jobs, total] = await Promise.all([
      ScrapeJob.find(filter)
        .select("-followers")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      ScrapeJob.countDocuments(filter),
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

// GET /api/scrape/:id - Get job status
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const job = await ScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    })
      .select("-followers")
      .lean();

    if (!job) return res.status(404).json({ error: "Job not found" });

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: "Failed to get job" });
  }
});

// POST /api/scrape/:id/pause - Pause a running job
router.post("/:id/pause", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const job = await ScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    if (
      !["collecting_followers", "fetching_bios", "pending"].includes(
        job.status,
      )
    ) {
      return res
        .status(400)
        .json({ error: `Cannot pause job with status: ${job.status}` });
    }

    const paused = instagramScraper.pauseJob(job._id.toString());

    if (!paused) {
      // Job not actively running in memory, set status directly
      job.status = "paused";
      await job.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to pause job" });
  }
});

// POST /api/scrape/:id/cancel - Cancel a running job
router.post("/:id/cancel", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const job = await ScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    if (
      !["collecting_followers", "fetching_bios", "pending"].includes(
        job.status,
      )
    ) {
      return res
        .status(400)
        .json({ error: `Cannot cancel job with status: ${job.status}` });
    }

    const cancelled = instagramScraper.cancelJob(job._id.toString());

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

// DELETE /api/scrape/:id - Delete a scrape job
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const job = await ScrapeJob.findOne({
      _id: req.params.id,
      account_id: req.account._id,
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    // Don't allow deleting active jobs — cancel first
    if (
      ["collecting_followers", "fetching_bios", "pending"].includes(job.status)
    ) {
      return res
        .status(400)
        .json({ error: "Cannot delete an active job. Cancel it first." });
    }

    await ScrapeJob.deleteOne({ _id: job._id });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete job" });
  }
});

module.exports = router;

const mongoose = require("mongoose");

const DeepScrapeJobSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    status: {
      type: String,
      enum: [
        "pending",
        "scraping_reels",
        "scraping_comments",
        "scraping_profiles",
        "qualifying",
        "completed",
        "failed",
        "cancelled",
        "paused",
      ],
      default: "pending",
    },

    // Configuration
    name: { type: String, default: null },
    seed_usernames: [{ type: String }],
    reel_limit: { type: Number, default: 10 },
    comment_limit: { type: Number, default: 100 },
    min_followers: { type: Number, default: 1000 },
    force_reprocess: { type: Boolean, default: false },
    promptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Prompt",
      default: null,
    },
    promptLabel: { type: String, default: null },

    // Stats
    stats: {
      reels_scraped: { type: Number, default: 0 },
      comments_scraped: { type: Number, default: 0 },
      unique_commenters: { type: Number, default: 0 },
      profiles_scraped: { type: Number, default: 0 },
      filtered_low_followers: { type: Number, default: 0 },
      sent_to_ai: { type: Number, default: 0 },
      qualified: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
      skipped_existing: { type: Number, default: 0 },
      leads_created: { type: Number, default: 0 },
      leads_updated: { type: Number, default: 0 },
    },

    // Checkpoint data for resume
    reel_urls: [{ type: String }],
    reel_seeds: [{ type: String }], // parallel to reel_urls — which seed each reel came from
    commenter_usernames: [{ type: String }],
    commenter_seed_map: { type: mongoose.Schema.Types.Mixed, default: {} }, // { username: [seed1, seed2] }
    comments_fetched_index: { type: Number, default: 0 }, // which reel index we've scraped comments up to
    profiles_fetched: { type: Number, default: 0 },
    comments_skipped: { type: Boolean, default: false },

    // Scheduling
    is_recurring: { type: Boolean, default: false },
    repeat_interval_days: { type: Number, default: null },
    next_run_at: { type: Date, default: null },
    parent_job_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeepScrapeJob",
      default: null,
    },

    current_apify_run_id: { type: String, default: null },
    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { collection: "deep_scrape_jobs", versionKey: false, timestamps: true },
);

DeepScrapeJobSchema.index({ account_id: 1, status: 1 });

module.exports = mongoose.model("DeepScrapeJob", DeepScrapeJobSchema);

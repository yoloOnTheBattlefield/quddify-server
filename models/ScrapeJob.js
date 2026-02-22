const mongoose = require("mongoose");

const ScrapeJobSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    target_username: { type: String, required: true },
    target_user_id: { type: String, default: null },
    status: {
      type: String,
      enum: [
        "pending",
        "collecting_followers",
        "fetching_bios",
        "completed",
        "failed",
        "cancelled",
        "paused",
      ],
      default: "pending",
    },

    // Configuration
    max_followers: { type: Number, default: null },

    // Qualification prompt (optional — if set, bios go through OpenAI)
    promptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Prompt",
      default: null,
    },
    promptLabel: { type: String, default: null },

    // Follower list (checkpoint)
    followers: [
      {
        _id: false,
        pk: { type: String },
        username: { type: String },
        full_name: { type: String },
      },
    ],
    cursor: { type: String, default: null },
    followers_done: { type: Boolean, default: false },

    // Bio-fetch progress
    bios_fetched: { type: Number, default: 0 },

    // Results
    leads_created: { type: Number, default: 0 },
    leads_updated: { type: Number, default: 0 },
    leads_skipped: { type: Number, default: 0 },
    leads_filtered: { type: Number, default: 0 },
    leads_unqualified: { type: Number, default: 0 },

    // Control
    cancel_requested: { type: Boolean, default: false },

    // Timing
    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
    error: { type: String, default: null },

    // Stats
    request_count: { type: Number, default: 0 },
  },
  { collection: "scrape_jobs", versionKey: false, timestamps: true },
);

module.exports = mongoose.model("ScrapeJob", ScrapeJobSchema);

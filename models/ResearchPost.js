const mongoose = require("mongoose");

const ResearchPostSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    competitor_handle: { type: String, required: true },
    post_type: { type: String, default: "reel" },
    reel_id: { type: String },
    reel_url: { type: String },
    caption: { type: String, default: "" },
    likes_count: { type: Number, default: 0 },
    comments_count: { type: Number, default: 0 },
    plays_count: { type: Number, default: 0 },
    posted_at: { type: Date, default: null },
    scraped_at: { type: Date, default: Date.now },
    deep_scrape_job_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeepScrapeJob",
      default: null,
    },
  },
  { collection: "research_posts", versionKey: false, timestamps: true },
);

ResearchPostSchema.index({ account_id: 1, competitor_handle: 1 });
ResearchPostSchema.index(
  { reel_id: 1, account_id: 1 },
  { unique: true, sparse: true },
);

module.exports = mongoose.model("ResearchPost", ResearchPostSchema);

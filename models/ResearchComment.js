const mongoose = require("mongoose");

const ResearchCommentSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    research_post_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ResearchPost",
      default: null,
    },
    reel_url: { type: String },
    commenter_username: { type: String, required: true },
    comment_text: { type: String, default: "" },
    scraped_at: { type: Date, default: Date.now },
    deep_scrape_job_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeepScrapeJob",
      default: null,
    },
  },
  { collection: "research_comments", versionKey: false, timestamps: true },
);

ResearchCommentSchema.index({ account_id: 1, commenter_username: 1 });
ResearchCommentSchema.index({ research_post_id: 1 });

module.exports = mongoose.model("ResearchComment", ResearchCommentSchema);

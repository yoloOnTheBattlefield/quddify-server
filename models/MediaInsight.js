const mongoose = require("mongoose");

// One document per Instagram post/reel, refreshed from the Graph API.
// Engagement numbers change over time, so this is a cache with a fetched_at,
// not a historical record.
const MediaInsightSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    ig_user_id: { type: String, required: true },
    media_id: { type: String, required: true },

    permalink: { type: String, default: null },
    caption: { type: String, default: null },
    media_type: { type: String, default: null }, // IMAGE | VIDEO | CAROUSEL_ALBUM
    media_product_type: { type: String, default: null }, // FEED | REELS | STORY
    thumbnail_url: { type: String, default: null },
    posted_at: { type: Date, default: null },

    // From the media object itself — always available.
    like_count: { type: Number, default: 0 },
    comments_count: { type: Number, default: 0 },

    // From the insights edge — needs instagram_manage_insights, and not every
    // metric is valid for every media type, so these stay null when unavailable
    // rather than pretending to be zero.
    views: { type: Number, default: null },
    reach: { type: Number, default: null },
    shares: { type: Number, default: null },
    saved: { type: Number, default: null },
    total_interactions: { type: Number, default: null },
    insights_error: { type: String, default: null },

    fetched_at: { type: Date, default: Date.now },
  },
  { collection: "media_insights", versionKey: false, timestamps: true },
);

MediaInsightSchema.index({ account_id: 1, media_id: 1 }, { unique: true });
MediaInsightSchema.index({ account_id: 1, posted_at: -1 });

module.exports = mongoose.model("MediaInsight", MediaInsightSchema);

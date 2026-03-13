const mongoose = require("mongoose");

const TrendingVideoSchema = new mongoose.Schema(
  {
    video_id: { type: String, required: true },
    title: { type: String, default: null },
    channel_name: { type: String, default: null },
    channel_id: { type: String, default: null },
    url: { type: String, default: null },
    thumbnail_url: { type: String, default: null },
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    category: { type: String, default: null },
    country: { type: String, default: null },
    published_at: { type: Date, default: null },
    scraped_at: { type: Date, default: Date.now },
    batch_id: { type: String, default: null },
  },
  { collection: "trending_videos", versionKey: false, timestamps: true },
);

TrendingVideoSchema.index({ batch_id: 1 });
TrendingVideoSchema.index({ category: 1, country: 1, scraped_at: -1 });
TrendingVideoSchema.index({ video_id: 1, batch_id: 1 });

module.exports = mongoose.model("TrendingVideo", TrendingVideoSchema);

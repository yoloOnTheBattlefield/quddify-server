const mongoose = require("mongoose");

const SnapshotSchema = new mongoose.Schema(
  {
    views: { type: Number, required: true },
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    scraped_at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const VideoSchema = new mongoose.Schema(
  {
    video_id: { type: String, required: true, unique: true },
    channel_id: { type: String, required: true },
    title: { type: String, default: null },
    url: { type: String, default: null },
    thumbnail_url: { type: String, default: null },
    published_at: { type: Date, default: null },
    duration: { type: String, default: null },
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    snapshots: { type: [SnapshotSchema], default: [] },
    views_per_hour: { type: Number, default: 0 },
    last_scraped_at: { type: Date, default: null },
  },
  { collection: "videos", versionKey: false, timestamps: true },
);

VideoSchema.index({ channel_id: 1, published_at: -1 });
VideoSchema.index({ views_per_hour: -1 });

module.exports = mongoose.model("Video", VideoSchema);

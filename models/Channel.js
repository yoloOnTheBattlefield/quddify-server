const mongoose = require("mongoose");

const ChannelSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    channel_id: { type: String, required: true },
    yt_channel_id: { type: String, default: null },
    channel_url: { type: String, default: null },
    channel_name: { type: String, default: null },
    description: { type: String, default: null },
    subscriber_count: { type: Number, default: null },
    video_count: { type: Number, default: null },
    last_scraped_at: { type: Date, default: null },
    active: { type: Boolean, default: true },
  },
  { collection: "channels", versionKey: false, timestamps: true },
);

ChannelSchema.index({ account_id: 1, channel_id: 1 }, { unique: true });

module.exports = mongoose.model("Channel", ChannelSchema);

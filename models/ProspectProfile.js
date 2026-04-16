const mongoose = require("mongoose");

const prospectProfileSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client" },
    ig_handle: { type: String, required: true },
    ig_bio: { type: String, default: "" },
    ig_profile_picture_url: { type: String },
    ig_followers_count: { type: Number },
    status: {
      type: String,
      enum: ["scraping", "profiling", "ready", "expired", "failed"],
      default: "scraping",
    },
    error: { type: String },
    current_step: { type: String, default: "" },
    progress: { type: Number, default: 0 },

    // Scraped raw data
    scraped_posts: [
      {
        url: String,
        image_urls: [String],
        caption: String,
        likes: { type: Number, default: 0 },
        comments: { type: Number, default: 0 },
        timestamp: Date,
        type: { type: String, enum: ["image", "carousel", "reel"], default: "image" },
      },
    ],
    scraped_reels: [
      {
        url: String,
        video_url: String,
        thumbnail_url: String,
        caption: String,
        likes: { type: Number, default: 0 },
        comments: { type: Number, default: 0 },
        views: { type: Number, default: 0 },
        timestamp: Date,
        transcript: String,
      },
    ],

    // AI-generated profile
    profile: {
      name: String,
      niche: String,
      offer: String,
      audience: String,
      core_message: String,
      voice_notes: String,
      content_angles: [String],
      cta_style: {
        mechanism: {
          type: String,
          enum: ["comment_keyword", "link_in_bio", "dm_trigger", "custom", "uncertain"],
          default: "uncertain",
        },
        detected_cta: String,
        confidence: { type: Number, default: 0 },
        evidence: [String],
      },
      top_performing_angles: [
        {
          angle: String,
          engagement_rate: Number,
        },
      ],
    },

    // Inferred brand
    inferred_brand: {
      primary_color: { type: String, default: "#000000" },
      secondary_color: { type: String, default: "#ffffff" },
      accent_color: { type: String, default: "#3b82f6" },
      style_notes: String,
    },

    // Temporary image workspace
    image_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "ClientImage" }],

    // Cost tracking
    cost: {
      apify_usd: { type: Number, default: 0 },
      claude_usd: { type: Number, default: 0 },
      openai_usd: { type: Number, default: 0 },
    },

    // Timing
    scrape_started_at: Date,
    generation_time_ms: Number,

    // TTL
    expires_at: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
  },
  { timestamps: true }
);

prospectProfileSchema.index({ account_id: 1, status: 1 });
prospectProfileSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("ProspectProfile", prospectProfileSchema);

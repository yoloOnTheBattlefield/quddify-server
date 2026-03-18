const mongoose = require("mongoose");

const ThumbnailConceptSchema = new mongoose.Schema(
  {
    label: { type: String, required: true }, // "a", "b", "c", "d"
    description: { type: String, default: "" },
    prompt: { type: String, default: "" },
    output_key: { type: String, default: null }, // storage key for generated PNG
  },
  { _id: false },
);

const ThumbnailJobSchema = new mongoose.Schema(
  {
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    status: {
      type: String,
      enum: ["queued", "generating", "combining", "completed", "failed"],
      default: "queued",
    },
    current_step: { type: String, default: "" },
    progress: { type: Number, default: 0 },
    error: { type: String, default: null },

    topic: { type: String, required: true },
    headshot_image_id: { type: mongoose.Schema.Types.ObjectId, ref: "ClientImage", required: true },
    template_id: { type: mongoose.Schema.Types.ObjectId, ref: "ThumbnailTemplate", default: null },
    reference_urls: [{ type: String }], // logos, icons, screenshots URLs

    concepts: [ThumbnailConceptSchema],
    comparison_key: { type: String, default: null },
    example_count: { type: Number, default: 0 }, // how many competitor thumbnails were found

    // Iteration tracking
    iterations: [
      {
        label: String,
        feedback: String,
        output_key: String,
        created_at: { type: Date, default: Date.now },
      },
    ],

    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
  },
  { collection: "thumbnail_jobs", versionKey: false, timestamps: { createdAt: "created_at" } },
);

ThumbnailJobSchema.index({ account_id: 1, client_id: 1 });
ThumbnailJobSchema.index({ status: 1 });

module.exports = mongoose.model("ThumbnailJob", ThumbnailJobSchema);

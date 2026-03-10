const mongoose = require("mongoose");

const CarouselJobSchema = new mongoose.Schema(
  {
    carousel_id: { type: mongoose.Schema.Types.ObjectId, ref: "Carousel", required: true },
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    status: {
      type: String,
      enum: [
        "queued",
        "analyzing_transcripts",
        "generating_copy",
        "selecting_images",
        "generating_images",
        "rendering_slides",
        "scoring",
        "completed",
        "failed",
      ],
      default: "queued",
    },
    current_step: { type: String, default: "" },
    progress: { type: Number, default: 0 },
    error: { type: String, default: null },
    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
  },
  { collection: "carousel_jobs", versionKey: false, timestamps: { createdAt: "created_at" } },
);

CarouselJobSchema.index({ status: 1 });
CarouselJobSchema.index({ carousel_id: 1 });

module.exports = mongoose.model("CarouselJob", CarouselJobSchema);

const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    type: {
      type: String,
      enum: ["carousel_ready", "carousel_failed", "transcript_ready", "transcript_failed", "thumbnail_ready", "general", "new_lead", "lead_replied"],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, default: "" },
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", default: null },
    carousel_id: { type: mongoose.Schema.Types.ObjectId, ref: "Carousel", default: null },
    read: { type: Boolean, default: false },
  },
  { collection: "notifications", versionKey: false, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

NotificationSchema.index({ account_id: 1, read: 1, created_at: -1 });

module.exports = mongoose.model("Notification", NotificationSchema);

const mongoose = require("mongoose");

const CarouselStyleSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    name: { type: String, required: true },
    style_prompt: { type: String, required: true },
    is_default: { type: Boolean, default: false },
  },
  { collection: "carousel_styles", versionKey: false, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

CarouselStyleSchema.index({ account_id: 1 });

module.exports = mongoose.model("CarouselStyle", CarouselStyleSchema);

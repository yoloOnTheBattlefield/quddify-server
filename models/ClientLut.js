const mongoose = require("mongoose");

const clientLutSchema = new mongoose.Schema(
  {
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    name: { type: String, required: true },
    storage_key: { type: String, required: true },
    original_filename: { type: String, required: true },
    format: { type: String, enum: ["cube", "3dl"], default: "cube" },
    size: { type: Number }, // LUT size (e.g., 33 for 33x33x33)
    file_size: { type: Number },
    preview_key: { type: String, default: null }, // optional preview thumbnail
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

clientLutSchema.index({ client_id: 1 });
clientLutSchema.index({ account_id: 1 });

module.exports = mongoose.model("ClientLut", clientLutSchema);

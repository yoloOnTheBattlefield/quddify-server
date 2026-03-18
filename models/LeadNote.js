const mongoose = require("mongoose");

const LeadNoteSchema = new mongoose.Schema(
  {
    lead_id: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },
    account_id: { type: String, required: true },
    author_id: { type: String, required: true },
    author_name: { type: String, required: true },
    content: { type: String, required: true },
  },
  {
    collection: "lead_notes",
    timestamps: true,
    versionKey: false,
  },
);

LeadNoteSchema.index({ lead_id: 1, createdAt: -1 });
LeadNoteSchema.index({ account_id: 1 });

module.exports = mongoose.model("LeadNote", LeadNoteSchema);

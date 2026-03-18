const mongoose = require("mongoose");

const LeadTaskSchema = new mongoose.Schema(
  {
    lead_id: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },
    account_id: { type: String, required: true },
    author_id: { type: String, required: true },
    author_name: { type: String, required: true },
    title: { type: String, required: true },
    due_date: { type: Date, default: null },
    completed_at: { type: Date, default: null },
  },
  {
    collection: "lead_tasks",
    timestamps: true,
    versionKey: false,
  },
);

LeadTaskSchema.index({ lead_id: 1, completed_at: 1, createdAt: -1 });
LeadTaskSchema.index({ account_id: 1 });

module.exports = mongoose.model("LeadTask", LeadTaskSchema);

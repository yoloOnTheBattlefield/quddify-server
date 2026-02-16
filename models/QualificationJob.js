const mongoose = require("mongoose");

const FileEntrySchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed"],
      default: "queued",
    },
    totalRows: { type: Number, default: 0 },
    filteredRows: { type: Number, default: 0 },
    processedRows: { type: Number, default: 0 },
    qualifiedCount: { type: Number, default: 0 },
    failedRows: { type: Number, default: 0 },
    sourceAccount: { type: String, default: null },
    scrapeDate: { type: String, default: null },
    error: { type: String, default: null },
  },
  { _id: false },
);

const QualificationJobSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    status: {
      type: String,
      enum: ["queued", "running", "completed", "failed", "cancelled"],
      default: "queued",
    },
    promptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Prompt",
      default: null,
    },
    promptLabel: { type: String, default: null },
    files: [FileEntrySchema],

    // Overall counters
    totalLeads: { type: Number, default: 0 },
    processedLeads: { type: Number, default: 0 },
    qualifiedLeads: { type: Number, default: 0 },
    failedLeads: { type: Number, default: 0 },

    // Timestamps
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // Column mapping for custom headers
    columnMapping: { type: mongoose.Schema.Types.Mixed, default: null },

    // Error / cancellation
    error: { type: String, default: null },
    cancelRequested: { type: Boolean, default: false },
  },
  {
    collection: "qualification_jobs",
    versionKey: false,
    timestamps: true,
  },
);

QualificationJobSchema.index({ account_id: 1, createdAt: -1 });
QualificationJobSchema.index({ status: 1 });

module.exports = mongoose.model("QualificationJob", QualificationJobSchema);

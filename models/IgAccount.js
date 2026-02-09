const mongoose = require("mongoose");

const IgAccountSchema = new mongoose.Schema(
  {
    accountKey: { type: String, required: true, unique: true },
    name: { type: String, default: null },
    scrapedCount: { type: Number, default: 0 },
    lastScraped: { type: Date, default: null },
    notes: { type: String, default: null },
    metadata: {
      source: { type: String },
      syncedAt: { type: Date },
    },
  },
  { collection: "ig_accounts", versionKey: false, timestamps: true },
);

module.exports = mongoose.model("IgAccount", IgAccountSchema);

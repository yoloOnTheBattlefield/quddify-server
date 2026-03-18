const mongoose = require("mongoose");

const advisoryClientSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    niche: { type: String },
    monthly_revenue: { type: Number },
    runway: { type: Number },
    constraint_type: {
      type: String,
      enum: ["delegation", "psychological", "conversion", "content", "systems", "ads"],
    },
    status: {
      type: String,
      enum: ["active", "paused", "churned"],
      default: "active",
    },
    health: {
      type: String,
      enum: ["green", "amber", "red"],
      default: "amber",
    },
    next_call_date: { type: Date },
    notes: { type: String },
  },
  { collection: "advisory_clients", versionKey: false, timestamps: true },
);

module.exports = mongoose.model("AdvisoryClient", advisoryClientSchema);

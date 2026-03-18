const mongoose = require("mongoose");

const advisoryMetricSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      index: true,
    },
    client_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdvisoryClient",
      required: true,
      index: true,
    },
    month: { type: String, required: true },
    cash_collected: { type: Number, default: 0 },
    mrr: { type: Number, default: 0 },
    calls_booked: { type: Number, default: 0 },
    calls_showed: { type: Number, default: 0 },
    calls_closed: { type: Number, default: 0 },
    expenses: { type: Number, default: 0 },
  },
  { collection: "advisory_metrics", versionKey: false, timestamps: true },
);

advisoryMetricSchema.index({ client_id: 1, month: 1 }, { unique: true });

module.exports = mongoose.model("AdvisoryMetric", advisoryMetricSchema);

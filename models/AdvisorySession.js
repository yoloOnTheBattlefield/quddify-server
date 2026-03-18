const mongoose = require("mongoose");

const actionItemSchema = new mongoose.Schema(
  {
    task: { type: String },
    owner: { type: String },
    due_date: { type: Date },
    completed: { type: Boolean, default: false },
  },
  { _id: true, versionKey: false },
);

const advisorySessionSchema = new mongoose.Schema(
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
    session_date: { type: Date, required: true },
    fathom_url: { type: String },
    bottleneck_identified: { type: String },
    summary: { type: String },
    action_items: [actionItemSchema],
  },
  { collection: "advisory_sessions", versionKey: false, timestamps: true },
);

module.exports = mongoose.model("AdvisorySession", advisorySessionSchema);

const mongoose = require("mongoose");

const ExtensionLogSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      default: null,
    },
    event: { type: String, required: true },
    level: {
      type: String,
      enum: ["debug", "info", "warn", "error"],
      default: "info",
    },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: Date.now },
  },
  { collection: "extension_logs", versionKey: false },
);

ExtensionLogSchema.index({ account_id: 1, timestamp: -1 });
ExtensionLogSchema.index({ taskId: 1 });
ExtensionLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2592000 });

module.exports = mongoose.model("ExtensionLog", ExtensionLogSchema);

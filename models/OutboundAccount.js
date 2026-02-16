const mongoose = require("mongoose");

const OutboundAccountSchema = new mongoose.Schema(
  {
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    username: { type: String, required: true },
    password: { type: String, default: null },
    email: { type: String, default: null },
    emailPassword: { type: String, default: null },
    proxy: { type: String, default: null },
    status: {
      type: String,
      enum: ["new", "warming", "ready", "restricted", "disabled"],
      default: "new",
    },
    isConnectedToAISetter: { type: Boolean, default: false },
    assignedTo: { type: String, default: null },
    isBlacklisted: { type: Boolean, default: false },
    notes: { type: String, default: null },
    twoFA: { type: String, default: null },
    warmup: {
      enabled: { type: Boolean, default: false },
      startDate: { type: Date, default: null },
      schedule: [
        {
          _id: false,
          day: { type: Number },
          cap: { type: Number },
        },
      ],
      checklist: [
        {
          _id: false,
          key: { type: String },
          label: { type: String },
          completed: { type: Boolean, default: false },
          completedAt: { type: Date, default: null },
          completedBy: { type: String, default: null },
        },
      ],
    },
  },
  { collection: "outbound_accounts", versionKey: false, timestamps: true },
);

OutboundAccountSchema.index({ account_id: 1, username: 1 }, { unique: true });
OutboundAccountSchema.index({ account_id: 1, status: 1 });
OutboundAccountSchema.index({ account_id: 1, isBlacklisted: 1 });

module.exports = mongoose.model("OutboundAccount", OutboundAccountSchema);

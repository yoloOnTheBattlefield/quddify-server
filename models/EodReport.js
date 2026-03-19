const mongoose = require("mongoose");

const EodReportSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    user_id: { type: String, required: true },
    user_name: { type: String, required: true },
    date: { type: String, required: true }, // "YYYY-MM-DD"
    stats: {
      dms_sent: { type: Number, default: 0 },
      replies_received: { type: Number, default: 0 },
      bookings_made: { type: Number, default: 0 },
      follow_ups_completed: { type: Number, default: 0 },
    },
    checklist: [{ label: { type: String }, checked: { type: Boolean, default: false } }],
    notes: { type: String, default: "" },
    mood: { type: Number, default: null }, // 1-5
  },
  { collection: "eod_reports", timestamps: true, versionKey: false },
);

EodReportSchema.index({ account_id: 1, date: -1 });
EodReportSchema.index({ account_id: 1, user_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("EodReport", EodReportSchema);

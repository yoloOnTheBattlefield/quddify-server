const mongoose = require("mongoose");

const InvitationSchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    first_name: { type: String, default: null },
    last_name: { type: String, default: null },
    token: { type: String, required: true, unique: true, index: true },
    type: { type: String, enum: ["client", "team_member"], required: true },
    // For client invites
    ghl: { type: String, default: null },
    // For team member invites
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    role: { type: Number, default: 2 },
    has_outbound: { type: Boolean, default: false },
    has_research: { type: Boolean, default: true },
    // Status tracking
    status: { type: String, enum: ["pending", "accepted", "expired"], default: "pending" },
    expires_at: { type: Date, required: true },
    invited_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { collection: "invitations", versionKey: false, timestamps: true },
);

module.exports = mongoose.model("Invitation", InvitationSchema);

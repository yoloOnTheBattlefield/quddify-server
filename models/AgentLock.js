const mongoose = require("mongoose");

// A short-lived per-conversation lock, so two agent runs fired by the same
// burst of DMs don't both reply. Mongo's TTL monitor removes expired rows
// (about once a minute); acquire logic also treats expired rows as free.
const agentLockSchema = new mongoose.Schema(
  {
    account_id: { type: String, required: true },
    ref_key: { type: String, required: true }, // resolved Lead _id
    run_id: { type: String, required: true },
    expires_at: { type: Date, required: true },
  },
  { collection: "agent_locks", versionKey: false, timestamps: { createdAt: "created_at", updatedAt: false } },
);

agentLockSchema.index({ account_id: 1, ref_key: 1 }, { unique: true });
agentLockSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("AgentLock", agentLockSchema);

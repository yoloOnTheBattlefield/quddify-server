const QualificationJob = require("../models/QualificationJob");

async function recoverStuckJobs() {
  const runningResult = await QualificationJob.updateMany(
    { status: "running" },
    {
      $set: {
        status: "failed",
        error: "Server restarted while job was running",
        completedAt: new Date(),
      },
    },
  );

  if (runningResult.modifiedCount > 0) {
    console.log(
      `[jobRecovery] Marked ${runningResult.modifiedCount} stuck running job(s) as failed`,
    );
  }

  // Queued jobs also lost their file buffers on restart
  const queuedResult = await QualificationJob.updateMany(
    { status: "queued" },
    {
      $set: {
        status: "failed",
        error: "Server restarted before job could start (file data lost)",
        completedAt: new Date(),
      },
    },
  );

  if (queuedResult.modifiedCount > 0) {
    console.log(
      `[jobRecovery] Marked ${queuedResult.modifiedCount} orphaned queued job(s) as failed`,
    );
  }
}

module.exports = { recoverStuckJobs };

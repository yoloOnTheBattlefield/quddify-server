// In-memory store: jobId -> [{ filename, buffer }]
const jobFileBuffers = new Map();

function storeBuffers(jobId, files) {
  jobFileBuffers.set(jobId, files);
}

function getBuffers(jobId) {
  return jobFileBuffers.get(jobId) || null;
}

function clearBuffers(jobId) {
  jobFileBuffers.delete(jobId);
}

module.exports = { storeBuffers, getBuffers, clearBuffers };

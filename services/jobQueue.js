let queue = [];
let isProcessing = false;
let processFn = null;

function init(processFunction) {
  processFn = processFunction;
}

function enqueue(jobId) {
  queue.push(jobId);
  drain();
}

async function drain() {
  if (isProcessing || queue.length === 0 || !processFn) return;

  isProcessing = true;
  const jobId = queue.shift();

  try {
    await processFn(jobId);
  } catch (err) {
    console.error(`[jobQueue] Unhandled error processing job ${jobId}:`, err);
  } finally {
    isProcessing = false;
    drain();
  }
}

function getQueueLength() {
  return queue.length;
}

function isRunning() {
  return isProcessing;
}

module.exports = { init, enqueue, getQueueLength, isRunning };

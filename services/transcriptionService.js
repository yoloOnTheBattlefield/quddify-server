const logger = require("../utils/logger").child({ module: "transcriptionService" });
const { getOpenAIClient } = require("../utils/aiClients");

const WHISPER_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB Whisper limit

/**
 * Transcribe audio buffer using OpenAI Whisper.
 * No duration limit — suitable for reels up to 90s.
 * @param {Buffer} buffer - audio file buffer
 * @param {string} mimeType - e.g. "audio/mp4"
 * @param {string} accountId - for resolving OpenAI client
 * @param {string} [filename] - optional filename hint
 * @returns {Promise<string>} transcription text
 */
async function transcribeAudio(buffer, mimeType, accountId, filename) {
  if (buffer.length > WHISPER_MAX_FILE_SIZE) {
    logger.warn(`Audio file too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB), skipping transcription`);
    return "";
  }

  const openai = await getOpenAIClient({ accountId });

  const ext = {
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
  }[mimeType] || "mp4";

  const file = new File([buffer], filename || `audio.${ext}`, { type: mimeType });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "en",
  });

  logger.info(`Transcribed: ${buffer.length} bytes → ${transcription.text.length} chars`);
  return transcription.text;
}

module.exports = { transcribeAudio };

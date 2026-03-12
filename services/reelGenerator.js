const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const logger = require("../utils/logger").child({ module: "reelGenerator" });

/**
 * Generate multiple reels from one video, each with a different text caption overlay.
 *
 * @param {string} videoPath  – absolute path to the source video
 * @param {string[]} captions – array of caption strings
 * @param {string} outputDir  – directory to write finished reels into
 * @param {object} [opts]     – optional styling overrides
 * @returns {Promise<string[]>} – array of output file paths
 */
async function generateReels(videoPath, captions, outputDir, opts = {}) {
  const {
    maxDuration = 10,
    fontSize = 64,
    fontColor = "white",
    borderWidth = 3,
    textX = 50,     // 0-100 percentage (center of text)
    textY = 50,     // 0-100 percentage (center of text)
    fontFamily = "Arial",
  } = opts;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Probe video duration so we can clamp to maxDuration
  const probe = await probeVideo(videoPath);
  const duration = Math.min(probe.duration || maxDuration, maxDuration);

  // Convert percentage position to FFmpeg drawtext expressions.
  // textX/textY represent the CENTER of the text, so we offset by half the text dimensions.
  const xExpr = `w*${textX / 100}-text_w/2`;
  const yExpr = `h*${textY / 100}-text_h/2`;

  const results = [];

  for (let i = 0; i < captions.length; i++) {
    const caption = captions[i];
    const outFile = path.join(outputDir, `reel_${i + 1}.mp4`);

    // Escape special chars for FFmpeg drawtext
    const escaped = caption
      .replace(/\\/g, "\\\\\\\\")
      .replace(/'/g, "'\\\\\\''")
      .replace(/:/g, "\\\\:")
      .replace(/%/g, "%%");

    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .duration(duration)
        .videoFilters([
          // Scale to 1080x1920 (9:16 vertical reel) with padding
          "scale=1080:1920:force_original_aspect_ratio=decrease",
          "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
          // Text overlay at user-specified position
          {
            filter: "drawtext",
            options: {
              text: escaped,
              fontsize: fontSize,
              fontcolor: fontColor,
              fontfile: "",
              font: fontFamily,
              x: xExpr,
              y: yExpr,
              borderw: borderWidth,
              bordercolor: "black",
              line_spacing: 12,
            },
          },
        ])
        .outputOptions([
          "-c:v", "libx264",
          "-preset", "fast",
          "-crf", "23",
          "-c:a", "aac",
          "-b:a", "128k",
          "-movflags", "+faststart",
          "-y",
        ])
        .output(outFile)
        .on("start", (cmd) => logger.info(`FFmpeg reel ${i + 1}: ${cmd}`))
        .on("end", () => {
          logger.info(`Reel ${i + 1} done → ${outFile}`);
          resolve(outFile);
        })
        .on("error", (err) => {
          logger.error(`Reel ${i + 1} failed:`, err);
          reject(err);
        })
        .run();
    });

    results.push(outFile);
  }

  return results;
}

function probeVideo(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format?.duration || 10;
      const width = metadata.streams?.[0]?.width || 1080;
      const height = metadata.streams?.[0]?.height || 1920;
      resolve({ duration, width, height });
    });
  });
}

module.exports = { generateReels, probeVideo };

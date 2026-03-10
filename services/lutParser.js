const logger = require("../utils/logger").child({ module: "lutParser" });

/**
 * Parse a .cube LUT file content.
 * @param {string} content - Raw .cube file text
 * @returns {{ title: string, size: number, data: Float32Array }}
 */
function parseCubeFile(content) {
  const lines = content.split("\n");
  let size = 0;
  let title = "";
  const data = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("TITLE")) {
      title = trimmed.replace(/^TITLE\s*"?/, "").replace(/"?\s*$/, "");
      continue;
    }
    if (trimmed.startsWith("DOMAIN_MIN") || trimmed.startsWith("DOMAIN_MAX")) continue;
    if (trimmed.startsWith("LUT_3D_SIZE")) {
      size = parseInt(trimmed.split(/\s+/)[1], 10);
      continue;
    }
    // Data line
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      data.push(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
    }
  }

  return { title, size, data: new Float32Array(data) };
}

/**
 * Apply LUT color transformation to a single pixel using trilinear interpolation.
 * @param {number} r - Red channel (0.0-1.0)
 * @param {number} g - Green channel (0.0-1.0)
 * @param {number} b - Blue channel (0.0-1.0)
 * @param {Float32Array} lut - Flat array of RGB values
 * @param {number} size - LUT grid size (e.g., 33)
 * @returns {number[]} [r, g, b] transformed values (0.0-1.0)
 */
function applyLutToPixel(r, g, b, lut, size) {
  const scale = size - 1;
  const rIdx = r * scale;
  const gIdx = g * scale;
  const bIdx = b * scale;

  const r0 = Math.floor(rIdx),
    r1 = Math.min(r0 + 1, scale);
  const g0 = Math.floor(gIdx),
    g1 = Math.min(g0 + 1, scale);
  const b0 = Math.floor(bIdx),
    b1 = Math.min(b0 + 1, scale);

  const rf = rIdx - r0;
  const gf = gIdx - g0;
  const bf = bIdx - b0;

  function sample(ri, gi, bi) {
    const idx = (bi * size * size + gi * size + ri) * 3;
    return [lut[idx], lut[idx + 1], lut[idx + 2]];
  }

  // Trilinear interpolation
  const c000 = sample(r0, g0, b0);
  const c100 = sample(r1, g0, b0);
  const c010 = sample(r0, g1, b0);
  const c110 = sample(r1, g1, b0);
  const c001 = sample(r0, g0, b1);
  const c101 = sample(r1, g0, b1);
  const c011 = sample(r0, g1, b1);
  const c111 = sample(r1, g1, b1);

  const result = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const c00 = c000[ch] * (1 - rf) + c100[ch] * rf;
    const c01 = c001[ch] * (1 - rf) + c101[ch] * rf;
    const c10 = c010[ch] * (1 - rf) + c110[ch] * rf;
    const c11 = c011[ch] * (1 - rf) + c111[ch] * rf;
    const c0 = c00 * (1 - gf) + c10 * gf;
    const c1 = c01 * (1 - gf) + c11 * gf;
    result[ch] = c0 * (1 - bf) + c1 * bf;
  }

  return result;
}

/**
 * Apply a LUT to an image buffer using Sharp.
 * @param {Buffer} imageBuffer - Input image buffer (JPEG, PNG, etc.)
 * @param {Float32Array} lutData - Flat array of RGB LUT values
 * @param {number} lutSize - LUT grid size (e.g., 33)
 * @returns {Promise<Buffer>} PNG buffer with LUT applied
 */
async function applyLutToBuffer(imageBuffer, lutData, lutSize) {
  const sharp = require("sharp");

  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  // Get raw pixel data
  const rawBuffer = await image.raw().toBuffer();
  const channels = metadata.channels || 3;

  const output = Buffer.alloc(rawBuffer.length);

  for (let i = 0; i < rawBuffer.length; i += channels) {
    const r = rawBuffer[i] / 255;
    const g = rawBuffer[i + 1] / 255;
    const b = rawBuffer[i + 2] / 255;

    const [nr, ng, nb] = applyLutToPixel(r, g, b, lutData, lutSize);

    output[i] = Math.round(Math.min(1, Math.max(0, nr)) * 255);
    output[i + 1] = Math.round(Math.min(1, Math.max(0, ng)) * 255);
    output[i + 2] = Math.round(Math.min(1, Math.max(0, nb)) * 255);

    // Copy alpha if present
    if (channels === 4) {
      output[i + 3] = rawBuffer[i + 3];
    }
  }

  return sharp(output, { raw: { width, height, channels } })
    .png()
    .toBuffer();
}

module.exports = { parseCubeFile, applyLutToBuffer, applyLutToPixel };

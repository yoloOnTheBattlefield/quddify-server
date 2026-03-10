const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger").child({ module: "storageService" });

// Local filesystem storage for MVP
// Files stored under ./uploads/<key>
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function upload(key, buffer, _contentType) {
  const filePath = path.join(UPLOAD_DIR, key);
  ensureDir(filePath);
  fs.writeFileSync(filePath, buffer);
  logger.info(`Stored file: ${key}`);
  return key;
}

/**
 * For local storage, just return the serve URL.
 * The express static middleware will serve files from /uploads.
 */
async function getPresignedUrl(key, _expiresIn = 3600) {
  return `/uploads/${key}`;
}

async function getFilePath(key) {
  return path.join(UPLOAD_DIR, key);
}

async function getBuffer(key) {
  const filePath = path.join(UPLOAD_DIR, key);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${key}`);
  return fs.readFileSync(filePath);
}

async function remove(key) {
  const filePath = path.join(UPLOAD_DIR, key);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    logger.info(`Deleted file: ${key}`);
  }
}

module.exports = { upload, getPresignedUrl, getFilePath, getBuffer, remove, UPLOAD_DIR };

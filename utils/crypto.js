const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

/**
 * Returns the encryption key from ENCRYPTION_KEY env var (32 bytes hex = 64 chars).
 * Returns null if not set or invalid.
 */
function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, "hex");
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns "iv:authTag:ciphertext" (all hex).
 * If ENCRYPTION_KEY is not set, returns plaintext unchanged.
 */
function encrypt(plaintext) {
  if (!plaintext || typeof plaintext !== "string") return plaintext;

  const key = getKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a ciphertext string in "iv:authTag:ciphertext" format.
 * If the value doesn't look encrypted (no colons / wrong format), returns it as-is
 * for backwards compatibility with plaintext values.
 * If ENCRYPTION_KEY is not set, returns the value unchanged.
 */
function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== "string") return ciphertext;

  // Check if it looks like an encrypted value (iv:authTag:ciphertext, all hex)
  const parts = ciphertext.split(":");
  if (parts.length !== 3) return ciphertext;

  const [ivHex, authTagHex, encryptedHex] = parts;

  // Validate hex format and expected lengths
  if (ivHex.length !== IV_LENGTH * 2) return ciphertext;
  if (authTagHex.length !== AUTH_TAG_LENGTH * 2) return ciphertext;
  if (!/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(authTagHex) || !/^[0-9a-f]+$/i.test(encryptedHex)) {
    return ciphertext;
  }

  const key = getKey();
  if (!key) return ciphertext;

  try {
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch {
    // If decryption fails (wrong key, corrupted data), return as-is
    return ciphertext;
  }
}

module.exports = { encrypt, decrypt };

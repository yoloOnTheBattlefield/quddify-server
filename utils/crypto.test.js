const { encrypt, decrypt } = require("./crypto");

describe("crypto utility", () => {
  const TEST_KEY = "a01b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b";

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  describe("round-trip encrypt then decrypt", () => {
    it("should return the original plaintext after encrypt + decrypt", () => {
      const plaintext = "sk-abc123-my-secret-api-key";
      const encrypted = encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it("should handle empty strings", () => {
      expect(encrypt("")).toBe("");
      expect(decrypt("")).toBe("");
    });

    it("should handle null and undefined", () => {
      expect(encrypt(null)).toBe(null);
      expect(encrypt(undefined)).toBe(undefined);
      expect(decrypt(null)).toBe(null);
      expect(decrypt(undefined)).toBe(undefined);
    });

    it("should handle long tokens", () => {
      const longToken = "EAAGm0PX4Zcg" + "x".repeat(200);
      const encrypted = encrypt(longToken);
      expect(decrypt(encrypted)).toBe(longToken);
    });

    it("should handle tokens with special characters", () => {
      const token = "tok_special!@#$%^&*()_+/=chars";
      const encrypted = encrypt(token);
      expect(decrypt(encrypted)).toBe(token);
    });
  });

  describe("random IV produces different ciphertexts", () => {
    it("should produce different ciphertexts for the same plaintext", () => {
      const plaintext = "sk-abc123";
      const encrypted1 = encrypt(plaintext);
      const encrypted2 = encrypt(plaintext);
      expect(encrypted1).not.toBe(encrypted2);
      // But both should decrypt to the same value
      expect(decrypt(encrypted1)).toBe(plaintext);
      expect(decrypt(encrypted2)).toBe(plaintext);
    });
  });

  describe("ciphertext format", () => {
    it("should produce iv:authTag:ciphertext format (all hex)", () => {
      const encrypted = encrypt("test-value");
      const parts = encrypted.split(":");
      expect(parts).toHaveLength(3);
      // IV = 12 bytes = 24 hex chars
      expect(parts[0]).toHaveLength(24);
      // Auth tag = 16 bytes = 32 hex chars
      expect(parts[1]).toHaveLength(32);
      // Ciphertext should be hex
      expect(parts[2]).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe("graceful fallback when ENCRYPTION_KEY is not set", () => {
    it("encrypt should return plaintext when key is missing", () => {
      delete process.env.ENCRYPTION_KEY;
      const plaintext = "sk-abc123";
      expect(encrypt(plaintext)).toBe(plaintext);
    });

    it("decrypt should return value unchanged when key is missing", () => {
      delete process.env.ENCRYPTION_KEY;
      // Even if it looks like encrypted format
      const encrypted = "abcdef012345678901234567:abcdef0123456789abcdef0123456789:deadbeef";
      expect(decrypt(encrypted)).toBe(encrypted);
    });

    it("encrypt should return plaintext when key has wrong length", () => {
      process.env.ENCRYPTION_KEY = "tooshort";
      expect(encrypt("test")).toBe("test");
    });
  });

  describe("backwards compatibility - decrypt of plaintext returns plaintext", () => {
    it("should return plaintext API keys unchanged", () => {
      const apiKey = "sk-proj-abc123def456";
      expect(decrypt(apiKey)).toBe(apiKey);
    });

    it("should return OAuth tokens unchanged", () => {
      const token = "EAAGm0PX4ZCgBALx1y2z3";
      expect(decrypt(token)).toBe(token);
    });

    it("should return empty string unchanged", () => {
      expect(decrypt("")).toBe("");
    });

    it("should return null unchanged", () => {
      expect(decrypt(null)).toBe(null);
    });

    it("should handle strings with colons that are not valid encrypted format", () => {
      const value = "some:random:value:with:colons";
      expect(decrypt(value)).toBe(value);
    });

    it("should handle strings with exactly 3 parts but wrong hex lengths", () => {
      const value = "short:nothex:data";
      expect(decrypt(value)).toBe(value);
    });
  });
});

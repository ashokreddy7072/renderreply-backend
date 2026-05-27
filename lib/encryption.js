/**
 * lib/encryption.js — Reusable AES-256-GCM Token Encryption Utility
 * 
 * Securely encrypts and decrypts long-lived Meta/Instagram API access tokens
 * before database operations to prevent credential exposure in plain text.
 */

const crypto = require('crypto');
const ALGORITHM = 'aes-256-gcm';

/**
 * Derives a secure 32-byte key from the ENCRYPTION_KEY environment variable.
 * Supports both a 64-char hex string and hashes any arbitrary length string safely to 32 bytes.
 * @returns {Buffer}
 */
function getSecretKey() {
  const rawKey = process.env.ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error('ENCRYPTION_KEY environment variable is not defined.');
  }
  
  // If key is a 64-character hex string, convert to raw bytes (32 bytes)
  if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  
  // Otherwise, hash the arbitrary key using SHA-256 to safely derive 32 bytes
  return crypto.createHash('sha256').update(rawKey).digest();
}

/**
 * Encrypt a text string using AES-256-GCM.
 * @param {string} text - Plain text access token
 * @returns {string} - Combined string format: 'iv_hex:ciphertext_hex:tag_hex'
 */
function encryptToken(text) {
  if (!text) return null;
  
  const key = getSecretKey();
  const iv = crypto.randomBytes(12); // GCM standard IV is 12 bytes
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag().toString('hex'); // 16-byte authentication tag
  
  return `${iv.toString('hex')}:${encrypted}:${tag}`;
}

/**
 * Decrypt a ciphertext string using AES-256-GCM.
 * @param {string} encryptedText - Encrypted colon-separated token string
 * @returns {string} - Decrypted plain text access token
 */
function decryptToken(encryptedText) {
  if (!encryptedText) return null;
  
  // Handle already decrypted or unencrypted plain-text tokens gracefully (backwards compatibility)
  if (!encryptedText.includes(':')) {
    return encryptedText;
  }
  
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format. Expected iv:ciphertext:tag');
  }
  
  const [ivHex, encryptedHex, tagHex] = parts;
  const key = getSecretKey();
  
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

module.exports = {
  encryptToken,
  decryptToken
};

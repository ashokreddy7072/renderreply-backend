/**
 * lib/logger.js — Structured JSON Logging Framework
 * 
 * Replaces console.log with production-grade JSON output.
 * Automatically parses, formats, and redacts sensitive credentials (e.g. Meta secrets, access tokens).
 */

const SENSITIVE_KEYS = [
  'access_token',
  'client_secret',
  'firebase_service_account',
  'encryption_key',
  'token',
  'secret',
  'key',
  'password'
];

/**
 * Deeply traverses an object or string and redacts any matching sensitive keys.
 * @param {any} item - The value to parse and redact
 * @returns {any}
 */
function redact(item) {
  if (item === null || item === undefined) return item;

  if (typeof item === 'string') {
    // Redact long Meta tokens starting with standard API prefixes, or GCM encrypted string lengths
    if (item.startsWith('IGAAV') || item.includes(':') && item.length > 80) {
      return '[REDACTED_CREDENTIAL]';
    }
    return item;
  }

  if (Array.isArray(item)) {
    return item.map(redact);
  }

  if (typeof item === 'object') {
    const redactedObj = {};
    for (const [key, value] of Object.entries(item)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.some(k => lowerKey.includes(k))) {
        redactedObj[key] = '[REDACTED_CREDENTIAL]';
      } else {
        redactedObj[key] = redact(value);
      }
    }
    return redactedObj;
  }

  return item;
}

/**
 * Outputs a standard JSON log line to stdout or stderr.
 * @param {string} level - Log level ('info', 'warn', 'error', 'fatal')
 * @param {string} message - Primary log message
 * @param {object} [meta] - Optional context metadata
 */
function log(level, message, meta = {}) {
  const logPayload = {
    level,
    event: meta.event || 'application_log',
    message: redact(message),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development'
  };

  if (meta && Object.keys(meta).length > 0) {
    // Filter out internal standard event parameters
    const { event, ...extra } = meta;
    if (Object.keys(extra).length > 0) {
      logPayload.meta = redact(extra);
    }
  }

  // Handle stdout vs stderr mapping
  if (level === 'error' || level === 'fatal') {
    console.error(JSON.stringify(logPayload));
  } else {
    console.log(JSON.stringify(logPayload));
  }
}

module.exports = {
  info:  (msg, meta) => log('info', msg, meta),
  warn:  (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  fatal: (msg, meta) => log('fatal', msg, meta)
};

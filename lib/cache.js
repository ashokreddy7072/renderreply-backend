/**
 * lib/cache.js — Shared Redis cache client
 *
 * All routes import this module so the entire app shares ONE Redis connection.
 * When REDIS_URL is not set (local dev without Upstash), every cache.get()
 * returns null and cache.set() is a no-op — the app falls back to Firestore
 * transparently with zero code changes in the routes.
 *
 * Upstash free tier setup:
 *   1. https://upstash.com → create a Redis database
 *   2. Copy the "REDIS_URL" from the dashboard (starts with rediss://)
 *   3. Add it to your .env:  REDIS_URL=rediss://...
 *   4. Add it to Render env vars as well
 */

const Redis = require('ioredis');

let redis = null;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    // Retry up to 3 times with exponential back-off before giving up
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    // Silence connection events so the server doesn't crash on Redis blips
    lazyConnect: true,
  });

  redis.on('connect', () => console.log('✅ Redis connected.'));
  redis.on('error',   (err) => console.warn('⚠️  Redis error (falling back to Firestore):', err.message));

  // Non-blocking connect — errors are handled above
  redis.connect().catch(() => {});
} else {
  console.log('ℹ️  REDIS_URL not set — cache disabled (Firestore only). Add Upstash URL to .env to enable shared cache.');
}

/**
 * Get a cached value.  Returns parsed object or null on miss / Redis down.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function get(key) {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Set a value with a TTL (seconds).  Silent no-op if Redis is down.
 * @param {string} key
 * @param {number} ttlSeconds
 * @param {any}    value
 */
async function set(key, ttlSeconds, value) {
  if (!redis) return;
  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
  } catch {
    // Never crash the request if Redis is unavailable
  }
}

/**
 * Delete one or more keys (cache busting on writes).
 * @param {...string} keys
 */
async function del(...keys) {
  if (!redis || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch {
    // Ignore
  }
}

module.exports = { get, set, del };

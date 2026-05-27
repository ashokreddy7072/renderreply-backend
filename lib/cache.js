const Redis = require('ioredis');
const logger = require('./logger');

let redis = null;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    // Retry up to 3 times with exponential back-off before giving up
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    // Silence connection events so the server doesn't crash on Redis blips
    lazyConnect: true,
  });

  redis.on('connect', () => logger.info('Redis connected successfully.', { event: 'redis_connected' }));
  redis.on('error',   (err) => logger.warn('Redis error (falling back to Firestore):', { event: 'redis_error', error: err.message }));

  // Non-blocking connect — errors are handled above
  redis.connect().catch(() => {});
} else {
  logger.info('REDIS_URL not set — cache disabled (Firestore only).', { event: 'redis_disabled' });
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
  } catch (err) {
    logger.error('Error fetching key from Redis:', { event: 'redis_get_error', key, error: err.message });
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
  } catch (err) {
    logger.error('Error setting key in Redis:', { event: 'redis_set_error', key, error: err.message });
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
  } catch (err) {
    logger.error('Error deleting keys from Redis:', { event: 'redis_del_error', keys, error: err.message });
  }
}

/**
 * Atomic Increment for rate-limiting. Returns the current counter value.
 * Automatically expires the key after the specified TTL.
 * @param {string} key
 * @param {number} ttlSeconds
 * @returns {Promise<number>}
 */
async function incr(key, ttlSeconds) {
  if (!redis) return 1;
  try {
    const multi = redis.multi();
    multi.incr(key);
    multi.ttl(key);
    const results = await multi.exec();
    
    // results is [[null, count], [null, currentTtl]] in ioredis
    const count = results[0][1];
    const ttl = results[1][1];
    
    // If the key is newly created (ttl was -1 or not set), set the expiration
    if (ttl === -1 || ttl === null) {
      await redis.expire(key, ttlSeconds);
    }
    
    return count;
  } catch (err) {
    logger.error('Error executing atomic incr in Redis:', { event: 'redis_incr_error', key, error: err.message });
    return 1;
  }
}

/**
 * Atomic SETNX (Set if Not Exists) for locking mechanisms.
 * Returns true if the key was set, false otherwise.
 * @param {string} key
 * @param {number} ttlSeconds
 * @param {any} value
 * @returns {Promise<boolean>}
 */
async function setnx(key, ttlSeconds, value) {
  if (!redis) return true; // Fallback to allowing execution if Redis is down
  try {
    const result = await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (err) {
    logger.error('Error executing setnx in Redis:', { event: 'redis_setnx_error', key, error: err.message });
    return true; // Fallback to allowing execution if Redis has errors
  }
}

module.exports = { get, set, del, incr, setnx };



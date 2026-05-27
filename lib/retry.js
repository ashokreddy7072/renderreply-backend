/**
 * lib/retry.js — Exponential Backoff Retry Utility
 * 
 * Elegant retrying wrapper for unstable network connections and strict API limits.
 * Intelligently catches and retries transient failures (e.g. status 429, 500, 502, 503, 504).
 */

const logger = require('./logger');

/**
 * Safely evaluates if an error represents a temporary transient network/server problem.
 * @param {Error} err
 * @returns {boolean}
 */
function isTransientError(err) {
  // Check HTTP response status codes
  const status = err.status || err.statusCode || (err.response && err.response.status);
  
  if (status) {
    // 429 Too Many Requests or 5xx Server Errors are transient
    return status === 429 || (status >= 500 && status <= 599);
  }
  
  // Timeout errors, fetch aborts, and generic dns/network disconnects are transient
  const lowerMsg = (err.message || '').toLowerCase();
  return (
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('abort') ||
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('etimedout') ||
    lowerMsg.includes('enotfound') ||
    lowerMsg.includes('network request timed out') ||
    lowerMsg.includes('fetch failed')
  );
}

/**
 * Execute an async operational function with strict retry counts and jitter-backed exponential spacing.
 * @template T
 * @param {() => Promise<T>} fn - Operational function to call
 * @param {number} [maxRetries=5] - Maximum total retries before crash
 * @param {number} [baseDelayMs=1000] - Exponential base delay mapping in milliseconds
 * @returns {Promise<T>}
 */
async function retry(fn, maxRetries = 5, baseDelayMs = 1000) {
  let attempt = 0;
  
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      
      const status = err.status || err.statusCode || (err.response && err.response.status);
      const transient = isTransientError(err);
      
      if (!transient || attempt > maxRetries) {
        logger.error(`[Retry] Execution failed permanently. Limit reached or non-transient error.`, {
          event: 'retry_failed_permanently',
          error: err.message,
          stack: err.stack,
          attempt,
          status,
          transient
        });
        throw err;
      }
      
      // Calculate delay: base * 2^(attempt - 1) + randomized jitter (up to 250ms) to prevent thundering herds
      const jitter = Math.random() * 250;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      
      logger.warn(`[Retry] Temporary request failure (Attempt ${attempt}/${maxRetries}). Retrying in ${Math.round(delay)}ms...`, {
        event: 'retry_attempt',
        error: err.message,
        status,
        delay: Math.round(delay)
      });
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

module.exports = retry;

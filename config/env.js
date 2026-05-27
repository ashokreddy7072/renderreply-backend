/**
 * config/env.js — Robust Environment Validation on Startup
 * 
 * Validates that all required environment variables are present and correctly formatted.
 * If any critical variable is missing, it logs a clear structured error and crashes the process.
 */

const requiredVars = [
  'FIREBASE_SERVICE_ACCOUNT',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_REDIRECT_URI',
  'DEEP_LINK_URI',
  'REDIS_URL',
  'ENCRYPTION_KEY',
  'NODE_ENV'
];

const missing = [];

for (const name of requiredVars) {
  // Support both FIREBASE_SERVICE_ACCOUNT and FIREBASE_SERVICE_ACCOUNT_JSON to be safe
  if (name === 'FIREBASE_SERVICE_ACCOUNT') {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      missing.push('FIREBASE_SERVICE_ACCOUNT (or FIREBASE_SERVICE_ACCOUNT_JSON)');
    }
  } else {
    if (!process.env[name]) {
      missing.push(name);
    }
  }
}

if (missing.length > 0) {
  console.error(JSON.stringify({
    level: 'fatal',
    event: 'startup_env_validation_failed',
    message: `CRITICAL STARTUP ERROR: Missing required environment variables: ${missing.join(', ')}`,
    ts: new Date().toISOString()
  }, null, 2));
  
  console.error('\n⛔ Process exiting due to misconfigured environment. Please check your .env file or Railway console.\n');
  process.exit(1);
}

// Perform simple syntax validations
try {
  const firebaseStr = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  JSON.parse(firebaseStr);
} catch (err) {
  console.error(JSON.stringify({
    level: 'fatal',
    event: 'startup_env_validation_failed',
    message: `CRITICAL STARTUP ERROR: FIREBASE_SERVICE_ACCOUNT must be a valid JSON string. Parse error: ${err.message}`,
    ts: new Date().toISOString()
  }, null, 2));
  process.exit(1);
}

// Export validated configuration for reuse across the app
module.exports = {
  firebaseServiceAccount: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
  metaAppId: process.env.META_APP_ID,
  metaAppSecret: process.env.META_APP_SECRET,
  metaRedirectUri: process.env.META_REDIRECT_URI,
  deepLinkUri: process.env.DEEP_LINK_URI,
  redisUrl: process.env.REDIS_URL,
  encryptionKey: process.env.ENCRYPTION_KEY,
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 3000
};

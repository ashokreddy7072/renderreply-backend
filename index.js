// --- 1. INITIALIZATION & ENV VALIDATION ---
const config = require('./config/env');
const logger = require('./lib/logger');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const crypto = require('crypto');
const cache = require('./lib/cache');
const retry = require('./lib/retry');

// Initialize Firebase Admin strictly using env variable (no insecure file fallback)
try {
  admin.initializeApp({
    credential: admin.credential.cert(config.firebaseServiceAccount)
  });
  logger.info('Firebase Admin initialized successfully from ENVs.', { event: 'firebase_initialized' });
} catch (error) {
  logger.fatal('Firebase Admin initialization failed. Exiting.', { event: 'firebase_init_failed', error: error.message });
  process.exit(1);
}

const app = express();

// --- 2. SECURITY MIDDLEWARE (SCALE & SECURE) ---
app.set('trust proxy', 1);

// Configure Secure Helmet headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://images.unsplash.com", "https://graph.instagram.com", "https://*.fbcdn.net"],
      connectSrc: ["'self'", "https://api.renderreply.com", "https://graph.facebook.com", "https://graph.instagram.com"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin' }
}));

// Configure Dynamic CORS Origin Validation from allowed whitelist
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['https://api.renderreply.com', 'http://localhost:8081', 'http://localhost:8082'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server calls (no origin) and listed whitelisted domains
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    logger.warn('CORS connection blocked for unauthorized origin.', { event: 'cors_blocked', origin });
    return callback(new Error(`CORS policy: origin '${origin}' is not allowed.`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '50kb' }));

// Redis-backed Distributed Rate Limiting Middleware (SaaS-Ready)
const redisRateLimiter = async (req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const key = `ratelimit:api:${ip}`;
  const LIMIT = 100; // 100 requests per window
  const WINDOW_SECONDS = 15 * 60; // 15 minutes window

  try {
    const current = await cache.incr(key, WINDOW_SECONDS);
    res.setHeader('X-RateLimit-Limit', LIMIT);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, LIMIT - current));

    if (current > LIMIT) {
      logger.warn('Distributed API rate limit exceeded by client IP.', { event: 'api_rate_limit_exceeded', ip, count: current });
      return res.status(429).json({ error: 'Too many requests from this IP, please try again after 15 minutes.' });
    }
    next();
  } catch (err) {
    logger.error('Redis rate limiter failure; falling back gracefully to allow traffic.', { event: 'redis_ratelimit_error', error: err.message });
    next();
  }
};

// Reusable Input Sanitization Middleware to prevent HTML injection and basic XSS vectors
const sanitizeInput = (req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    for (const [key, value] of Object.entries(req.body)) {
      if (typeof value === 'string') {
        req.body[key] = value.replace(/[<>]/g, '').trim();
      }
    }
  }
  if (req.query && typeof req.query === 'object') {
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') {
        req.query[key] = value.replace(/[<>]/g, '').trim();
      }
    }
  }
  next();
};

// Apply security rate limiter and input sanitization to all API pathways
app.use('/api/', redisRateLimiter, sanitizeInput);

// Helper fetch wrapper to throw errors with status code on non-ok responses so retry() can back-off
const secureFetch = async (url, options = {}) => {
  return retry(async () => {
    const res = await fetch(url, options);
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const errMessage = errBody.error?.message || `Meta API Error ${res.status}`;
      const status = res.status;
      
      const err = new Error(errMessage);
      err.status = status;
      err.response = res;
      throw err;
    }
    return res;
  }, 3);
};

// --- 3. FIREBASE AUTH MIDDLEWARE ---
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    if (admin.apps.length === 0) throw new Error("Firebase app not initialized.");
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    logger.warn('Firebase JWT authentication verification failed.', { event: 'jwt_verify_failed', error: error.message });
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};


// --- 4. SECURE INSTAGRAM OAUTH CALLBACK ROUTE ---

// Endpoint called by frontend to generate a secure random CSRF state and retrieve Auth URL
app.post('/api/social/oauth-start', verifyToken, async (req, res) => {
  try {
    const userUid = req.user.uid;
    // Generate secure cryptographically random state token
    const stateToken = crypto.randomBytes(16).toString('hex');
    
    // Store in Upstash Redis cache mapped to actual userUid, expiring in 10 minutes (600s)
    await cache.set(`oauth_state:${stateToken}`, 600, userUid);
    
    const metaScope = 'instagram_basic,instagram_manage_comments,instagram_manage_insights,pages_show_list,pages_read_engagement,pages_manage_engagement';
    const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${config.metaAppId}&redirect_uri=${encodeURIComponent(config.metaRedirectUri)}&scope=${metaScope}&response_type=code&state=${stateToken}`;
    
    res.json({ authUrl });
  } catch (err) {
    logger.error('Error starting secure OAuth state initialization.', { event: 'oauth_start_failed', error: err.message });
    res.status(500).json({ error: 'Failed to initialize secure authentication session.' });
  }
});

// GET /auth/instagram/callback (Public OAuth redirect handler from Meta Graph API)
app.get('/auth/instagram/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    logger.warn('OAuth Callback invoked with missing parameters.', { event: 'oauth_callback_invalid_params' });
    const errLink = `${config.deepLinkUri}?status=error&message=${encodeURIComponent('Authentication parameters are missing.')}`;
    return res.redirect(errLink);
  }

  try {
    // 1. CSRF Verification: verify the state token exists and is valid in Redis
    const userUid = await cache.get(`oauth_state:${state}`);
    if (!userUid) {
      logger.error('CSRF State verification failed or state token expired.', { event: 'oauth_csrf_failed', state });
      const errLink = `${config.deepLinkUri}?status=error&message=${encodeURIComponent('Security verification failed. Session expired.')}`;
      return res.redirect(errLink);
    }

    // Immediately bust the state to prevent replay attacks
    await cache.del(`oauth_state:${state}`);

    logger.info('CSRF state token verified. Exchanging auth code for Instagram credentials.', { event: 'oauth_csrf_success', userUid });

    // 2. Exchange code for a short-lived user access token
    const shortTokenRes = await secureFetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${config.metaAppId}&redirect_uri=${encodeURIComponent(config.metaRedirectUri)}&client_secret=${config.metaAppSecret}&code=${code}`
    );
    const shortTokenData = await shortTokenRes.json();
    const shortLivedToken = shortTokenData.access_token;

    // 3. Exchange short-lived token for a long-lived user access token (60-day expiry)
    const longTokenRes = await secureFetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${config.metaAppId}&client_secret=${config.metaAppSecret}&fb_exchange_token=${shortLivedToken}`
    );
    const longTokenData = await longTokenRes.json();
    const longLivedToken = longTokenData.access_token;
    const expiresIn = longTokenData.expires_in || 5184000; // default to 60 days in seconds
    const expiresAt = Date.now() + expiresIn * 1000;

    // 4. Resolve Instagram Business Account ID by querying pages
    let accountId = null;
    let username = 'Instagram Business Account';

    const pageRes = await secureFetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${longLivedToken}`);
    const pageData = await pageRes.json();
    if (pageData.data && pageData.data.length > 0) {
      const pageId = pageData.data[0].id;
      const igRes = await secureFetch(`https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account&access_token=${longLivedToken}`);
      const igData = await igRes.json();
      if (igData.instagram_business_account) {
        accountId = igData.instagram_business_account.id;
        
        // Fetch account username
        const accountInfoRes = await secureFetch(`https://graph.facebook.com/v19.0/${accountId}?fields=username&access_token=${longLivedToken}`);
        const accountInfo = await accountInfoRes.json();
        username = accountInfo.username || 'ConnectedAccount';
      }
    }

    if (!accountId) {
      throw new Error('Failed to resolve an Instagram Business Account connected to your Facebook Page.');
    }

    // 5. Encrypt the access token using AES-256-GCM before writing to database
    const { encryptToken } = require('./lib/encryption');
    const encryptedToken = encryptToken(longLivedToken);

    // 6. Save or update Firestore social_connections
    const db = admin.firestore();
    
    // Check if connection already exists to prevent duplicate rows
    const existingSnap = await db.collection('social_connections')
      .where('user_uid', '==', userUid)
      .where('platform', '==', 'instagram')
      .limit(1)
      .get();

    const connectionData = {
      user_uid: userUid,
      platform: 'instagram',
      access_token: encryptedToken,
      account_id: accountId,
      username,
      is_connected: true,
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    };

    if (!existingSnap.empty) {
      const docId = existingSnap.docs[0].id;
      await db.collection('social_connections').doc(docId).update(connectionData);
      logger.info('Updated existing Instagram connection in Firestore.', { event: 'social_connection_updated', userUid, accountId });
    } else {
      await db.collection('social_connections').add(connectionData);
      logger.info('Created new Instagram connection in Firestore.', { event: 'social_connection_created', userUid, accountId });
    }

    // Bust the stats cache to reflect the connected account immediately
    await cache.del(`stats_${userUid}`);

    // 7. Successful redirect deep link back into Expo App
    const successLink = `${config.deepLinkUri}?status=success&username=${encodeURIComponent(username)}`;
    res.redirect(successLink);

  } catch (error) {
    logger.error('OAuth Callback flow failed completely.', { event: 'oauth_callback_failed', error: error.message });
    const errLink = `${config.deepLinkUri}?status=error&message=${encodeURIComponent(error.message || 'Authentication flow failed.')}`;
    res.redirect(errLink);
  }
});


// --- 5. ROUTES ---
const statsRoutes = require('./routes/stats');
const automationsRoutes = require('./routes/automations');
const socialRoutes = require('./routes/social');
const referralsRoutes = require('./routes/referrals');

app.use('/api/stats', verifyToken, statsRoutes);
app.use('/api/automations', verifyToken, automationsRoutes);
app.use('/api/social', verifyToken, socialRoutes);
app.use('/api/referrals', verifyToken, referralsRoutes);

// --- 6. HEALTH & ENVIRONMENT MONITORING ENDPOINT ---
app.get('/api/health', async (req, res) => {
  let redisStatus = 'disconnected';
  let redisLatencyMs = null;
  let firestoreStatus = 'disconnected';
  let firestoreLatencyMs = null;
  let workerStatus = 'offline';
  let workerAgeSeconds = null;

  // 1. Measure Redis Health and Latency
  try {
    const start = Date.now();
    const pingResult = await cache.incr('health_ping', 5);
    redisLatencyMs = Date.now() - start;
    if (pingResult) redisStatus = 'healthy';
  } catch (e) {
    redisStatus = `unhealthy: ${e.message}`;
  }

  // 2. Measure Firestore Health and Latency
  try {
    const start = Date.now();
    const db = admin.firestore();
    await db.collection('system').doc('health').get();
    firestoreLatencyMs = Date.now() - start;
    firestoreStatus = 'healthy';
  } catch (e) {
    firestoreStatus = `unhealthy: ${e.message}`;
  }

  // 3. Inspect Background Worker Status & Heartbeat age from Redis
  try {
    const lastHeartbeat = await cache.get('worker_heartbeat');
    if (lastHeartbeat) {
      workerAgeSeconds = (Date.now() - Number(lastHeartbeat)) / 1000;
      if (workerAgeSeconds < 180) { // Under 3 minutes is healthy
        workerStatus = 'healthy';
      } else {
        workerStatus = `stale (${Math.round(workerAgeSeconds)}s ago)`;
      }
    } else {
      workerStatus = 'no_heartbeat_recorded';
    }
  } catch (e) {
    workerStatus = `unknown: ${e.message}`;
  }

  const isHealthy = redisStatus === 'healthy' && firestoreStatus === 'healthy' && workerStatus === 'healthy';

  res.status(isHealthy ? 200 : 500).json({
    status: isHealthy ? 'healthy' : 'degraded',
    uptime: process.uptime(),
    nodeEnv: config.nodeEnv,
    memoryUsage: process.memoryUsage(),
    services: {
      redis: {
        status: redisStatus,
        latencyMs: redisLatencyMs
      },
      firestore: {
        status: firestoreStatus,
        latencyMs: firestoreLatencyMs
      },
      worker: {
        status: workerStatus,
        lastHeartbeatAgeSeconds: workerAgeSeconds ? Math.round(workerAgeSeconds) : null
      }
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    metaAppId: config.metaAppId,
    redirectUri: config.metaRedirectUri,
    metaScope: 'instagram_basic,instagram_manage_comments,instagram_manage_insights,pages_show_list,pages_read_engagement,pages_manage_engagement',
  });
});


// --- 7. GLOBAL ERROR HANDLER ---
app.use((err, req, res, next) => {
  const isDev = config.nodeEnv === 'development';
  logger.error('Unhandled Server Exception occurred.', {
    event: 'unhandled_server_exception',
    error: err.message,
    stack: err.stack
  });
  
  res.status(500).json({
    error: 'Internal Server Error',
    ...(isDev ? { message: err.message, stack: err.stack } : {})
  });
});

// --- 8. START SERVER ---
// NOTE: The commentPollWorker runs as a SEPARATE process (worker.js).
// It is intentionally NOT imported here so it never competes with the API
// server for CPU or memory. At 1 Lakh users this separation is mandatory.
const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(`API Server running successfully on port ${config.port}.`, {
    event: 'api_server_started',
    port: config.port,
    nodeEnv: config.nodeEnv
  });
});

// --- 9. GRACEFUL SHUTDOWN ---
const shutdown = (signal) => {
  logger.info(`Received ${signal} shutdown event — gracefully closing Express connections...`, {
    event: 'shutdown_initiated',
    signal
  });
  
  server.close(() => {
    logger.info('All network connections closed cleanly. Process exiting.', { event: 'shutdown_complete' });
    process.exit(0);
  });

  // Force exit after 15 seconds if connections are still open (e.g., keep-alive sockets)
  setTimeout(() => {
    logger.error('Forced shutdown invoked after 15s timeout.', { event: 'shutdown_forced_timeout' });
    process.exit(1);
  }, 15000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));


require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');


// --- 1. FIREBASE INIT ---
try {
  const serviceAccount = require('./firebase-service-account.json');
  if (serviceAccount.project_id === "your-project-id") {
    console.warn("⚠️ Using placeholder firebase-service-account.json. Firebase Auth will not work until you replace it with your real credentials.");
  } else {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin initialized.");
  }
} catch (error) {
  console.error("⚠️ Error initializing Firebase:", error);
  console.warn("⚠️ Could not load firebase-service-account.json. Please add it to the root of the backend folder.");
}
const app = express();

// --- 3. PRODUCTION MIDDLEWARE (SCALE & SECURE) ---
// Secure HTTP headers
app.use(helmet());

// Configure CORS — in production set ALLOWED_ORIGINS in your .env / Render env vars.
// Example: ALLOWED_ORIGINS=https://yourapp.com,exp://192.168.1.10:8081
// Falls back to '*' if not set so local dev works without configuration.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : null;

app.use(cors({
  origin: ALLOWED_ORIGINS
    ? (origin, callback) => {
        // Allow server-to-server calls (no origin header) and listed origins
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS: origin '${origin}' not allowed`));
      }
    : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Parse JSON bodies — cap at 50kb to prevent payload-based DDoS / memory spikes
app.use(express.json({ limit: '50kb' }));

// Global Rate Limiting: 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);


// --- 4. FIREBASE AUTH MIDDLEWARE ---
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
    console.error('Token verification error:', error.message);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

// --- 5. ROUTES ---
const statsRoutes = require('./routes/stats');
const automationsRoutes = require('./routes/automations');
const socialRoutes = require('./routes/social');
const referralsRoutes = require('./routes/referrals');

app.use('/api/stats', verifyToken, statsRoutes);
app.use('/api/automations', verifyToken, automationsRoutes);
app.use('/api/social', verifyToken, socialRoutes);
app.use('/api/referrals', verifyToken, referralsRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'Backend is healthy and running.' }));

// --- PUBLIC CONFIG ENDPOINT ---
// Returns safe-to-expose config values to the frontend app.
// Secrets like META_APP_SECRET and INSTAGRAM_ACCESS_TOKEN are NEVER included here.
// Frontend calls this once on startup instead of reading from its own .env.
app.get('/api/config', (req, res) => {
  res.json({
    metaAppId:    process.env.META_APP_ID,
    redirectUri:  process.env.META_REDIRECT_URI,
    metaScope:    'instagram_basic,instagram_manage_comments,instagram_manage_insights,pages_show_list,pages_read_engagement',
  });
});

// --- 6. GLOBAL ERROR HANDLER ---
app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// --- 7. START SERVER ---
// NOTE: The commentPollWorker runs as a SEPARATE process (worker.js).
// It is intentionally NOT imported here so it never competes with the API
// server for CPU or memory. At 1 Lakh users this separation is mandatory.
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 API Server running on http://0.0.0.0:${PORT}`);
  console.log(`ℹ️  Comment poll worker runs separately — start with: npm run dev:worker`);
});

// --- 8. GRACEFUL SHUTDOWN ---
// When the hosting platform (Cloud Run, Render, etc.) stops the container it sends
// SIGTERM. Without this handler, in-flight requests are killed instantly which causes
// client errors. We give active requests 15 seconds to finish before hard-exiting.
const shutdown = (signal) => {
  console.log(`\n⚡ ${signal} received — gracefully shutting down...`);
  server.close(() => {
    console.log('✅ All connections closed. Process exiting cleanly.');
    process.exit(0);
  });

  // Force exit after 15 seconds if connections are still open (e.g., keep-alive sockets)
  setTimeout(() => {
    console.error('⛔ Forced exit after 15s timeout.');
    process.exit(1);
  }, 15000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

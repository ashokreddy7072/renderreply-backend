/**
 * worker.js — Standalone Comment Poll Worker Process
 *
 * This file runs as a COMPLETELY SEPARATE process from the API server (index.js).
 * It has its own CPU, its own memory, and its own Node.js event loop.
 *
 * Why separate?
 * - At 1 Lakh users, polling 100,000 Instagram accounts every 60 seconds
 *   consumes significant CPU. If that ran inside the API server, every user
 *   hitting the dashboard would experience slow responses while the worker runs.
 * - By separating, the API server stays instant (< 100ms responses) no matter
 *   how heavy the background polling gets.
 *
 * How to run locally (two terminals):
 *   Terminal 1: npm run dev:api     → starts the API server
 *   Terminal 2: npm run dev:worker  → starts this worker
 *
 * How to deploy (two separate containers / services):
 *   Container 1: node index.js      → API server
 *   Container 2: node worker.js     → This worker
 */

require('dotenv').config();
const admin = require('firebase-admin');

// --- 1. FIREBASE INIT ---
try {
  const serviceAccount = require('./firebase-service-account.json');
  if (serviceAccount.project_id === 'your-project-id') {
    console.warn('⚠️ Using placeholder firebase-service-account.json. Worker will not function until replaced.');
  } else {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Worker: Firebase Admin initialized.');
  }
} catch (error) {
  console.error("⚠️ Error initializing Firebase in worker:", error);
  console.warn('⚠️ Worker: Could not load firebase-service-account.json.', error.message);
}

// --- 2. START THE WORKER ---
try {
  const startCommentPollWorker = require('./commentPollWorker');
  startCommentPollWorker();
  console.log('🤖 Worker process is running independently. API server is unaffected.');
} catch (error) {
  console.error('❌ Worker: Failed to start commentPollWorker:', error);
  process.exit(1);
}

// --- 3. GRACEFUL SHUTDOWN ---
const shutdown = (signal) => {
  console.log(`\n⚡ Worker received ${signal} — shutting down gracefully...`);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

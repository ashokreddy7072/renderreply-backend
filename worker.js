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

// --- 1. INITIALIZATION & ENV VALIDATION ---
require('./lib/sentry');
const config = require('./config/env');
const logger = require('./lib/logger');
const admin = require('firebase-admin');

// Initialize Firebase Admin strictly using env variable (no insecure file fallback)
try {
  admin.initializeApp({
    credential: admin.credential.cert(config.firebaseServiceAccount)
  });
  logger.info('Worker: Firebase Admin initialized successfully from ENVs.', { event: 'firebase_initialized' });
} catch (error) {
  logger.fatal('Worker: Firebase Admin initialization failed. Exiting.', { event: 'firebase_init_failed', error: error.message });
  process.exit(1);
}

// --- 2. START THE WORKER ---
let shutdownWorkerFn = null;

try {
  const { startCommentConsumerWorker, shutdownWorker } = require('./workers/commentConsumer');
  shutdownWorkerFn = shutdownWorker;
  startCommentConsumerWorker();
  logger.info('🤖 BullMQ Worker process is running independently. API server is unaffected.', { event: 'worker_started' });
} catch (error) {
  logger.error('❌ Worker: Failed to start comment consumer worker:', { event: 'worker_start_failed', error: error.message });
  process.exit(1);
}

// --- 3. GRACEFUL SHUTDOWN ---
const shutdown = async (signal) => {
  logger.info(`⚡ Worker received ${signal} — shutting down gracefully...`, { event: 'worker_shutdown', signal });
  if (shutdownWorkerFn) {
    try {
      await shutdownWorkerFn();
    } catch (err) {
      logger.error('Error closing worker on shutdown:', { event: 'worker_shutdown_error', error: err.message });
    }
  }
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Global crash prevention
process.on('uncaughtException', (err) => {
  logger.fatal('Uncaught Exception captured globally in worker.', { event: 'uncaught_exception', error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal('Unhandled Rejection captured globally in worker.', { event: 'unhandled_rejection', reason: String(reason) });
});


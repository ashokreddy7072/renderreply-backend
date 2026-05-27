/**
 * backend/lib/sentry.js — Sentry Error Tracking & Performance Monitoring
 */

const Sentry = require('@sentry/node');

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn: dsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
  });
  console.log('Sentry monitoring initialized.');
} else {
  console.log('Sentry DSN not provided — skipping Sentry initialization.');
}

module.exports = Sentry;

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const logger = require('../lib/logger');
const { enqueueCommentJob } = require('../queue/producer');

const META_APP_SECRET = process.env.META_APP_SECRET || 'mock_meta_secret';
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'renderreply_secure_webhook';

// ---------------------------------------------------------------------------
// GET /api/webhooks/instagram — Meta Webhook Challenge Verification
// ---------------------------------------------------------------------------
router.get('/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    logger.info('Meta Webhook verified successfully.', { event: 'meta_webhook_verified' });
    res.status(200).send(challenge);
  } else {
    logger.warn('Meta Webhook verification failed.', { event: 'meta_webhook_verification_failed' });
    res.sendStatus(403);
  }
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/instagram — Meta Webhook Payload Receiver
// ---------------------------------------------------------------------------
router.post('/instagram', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // 1. Verify X-Hub-Signature-256
    const signatureHeader = req.headers['x-hub-signature-256'];
    if (!signatureHeader) {
      logger.warn('Missing Meta Webhook Signature.', { event: 'meta_webhook_missing_signature' });
      return res.sendStatus(401);
    }

    const [algorithm, signature] = signatureHeader.split('=');
    const expectedSignature = crypto
      .createHmac('sha256', META_APP_SECRET)
      .update(req.body)
      .digest('hex');

    if (expectedSignature !== signature) {
      logger.error('Invalid Meta Webhook Signature.', { event: 'meta_webhook_invalid_signature' });
      return res.sendStatus(401);
    }

    // 2. Parse payload safely
    const bodyString = req.body.toString('utf8');
    const payload = JSON.parse(bodyString);

    if (payload.object !== 'instagram') {
      return res.sendStatus(404);
    }

    // 3. Process entries
    for (const entry of payload.entry) {
      const accountId = entry.id;
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field === 'comments') {
          await enqueueCommentJob({ ...change, accountId, eventType: 'comment' });
        } else if (change.field === 'mentions') {
          await enqueueCommentJob({ ...change, accountId, eventType: 'mention' });
        }
      }
      
      const messaging = entry.messaging || [];
      for (const msgEvent of messaging) {
        if (msgEvent.message && !msgEvent.message.is_echo) {
          await enqueueCommentJob({
            value: {
              id: msgEvent.message.mid,
              text: msgEvent.message.text,
              from: { id: msgEvent.sender.id, username: 'ig_user' },
              messageEvent: msgEvent
            },
            accountId,
            eventType: 'dm'
          });
        }
      }
    }

    // Meta requires a 200 OK fast to prevent retries
    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    logger.error('Error processing Meta Webhook', { event: 'meta_webhook_error', error: error.message });
    // Still return 200 so Meta doesn't throttle us if our JSON parsing fails on weird payloads
    res.status(200).send('ERROR_HANDLED');
  }
});

module.exports = router;

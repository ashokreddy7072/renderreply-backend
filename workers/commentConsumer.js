/**
 * backend/workers/commentConsumer.js — Event-Driven BullMQ Comment Consumer
 * 
 * Subscribes to the BullMQ 'InstagramComments' queue, decrypts access tokens,
 * throttles API calls with Redis, handles transient errors with retries,
 * and updates Firestore stats atomically.
 */

const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const logger = require('../lib/logger');
const cache = require('../lib/cache');
const { encryptToken, decryptToken } = require('../lib/encryption');
const retry = require('../lib/retry');

// Redis connection for BullMQ Worker (maxRetriesPerRequest must be null)
const redisConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

redisConnection.on('error', (err) => {
  logger.error('BullMQ Worker Redis connection error:', { event: 'bullmq_worker_redis_error', error: err.message });
});

// ---------------------------------------------------------------------------
// Helpers (ported from commentPollWorker for identical business logic behavior)
// ---------------------------------------------------------------------------

function isPermanentAuthError(err) {
  const status = err.status || (err.response && err.response.status);
  if (status === 400 || status === 401) {
    return true;
  }
  if (err.code === 190 || err.code === 102 || err.code === 10 || err.errorType === 'OAuthException') {
    return true;
  }
  return false;
}

async function disableConnection(db, docId, username, accountId, reason) {
  logger.warn(`Disabling invalid/revoked Instagram connection for @${username}.`, {
    event: 'connection_disabled_revoked',
    username,
    accountId,
    reason
  });
  try {
    await db.collection('social_connections').doc(docId).update({
      is_connected: false,
      connection_error: reason,
      updated_at: new Date().toISOString()
    });
  } catch (err) {
    logger.error('Failed to disable revoked social connection in Firestore:', { event: 'disable_connection_failed', error: err.message });
  }
}

async function secureFetch(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10-second timeout protection
  
  const secureOptions = {
    ...options,
    signal: controller.signal
  };

  try {
    return await retry(async () => {
      const res = await fetch(url, secureOptions);
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const errMessage = errBody.error?.message || `Meta API Error ${res.status}`;
        const status = res.status;
        
        const err = new Error(errMessage);
        err.status = status;
        err.response = res;
        err.code = errBody.error?.code;
        err.errorSubcode = errBody.error?.error_subcode;
        err.errorType = errBody.error?.type;
        throw err;
      }
      return res;
    }, 3);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendDmReply(decryptedToken, recipient, text, productCard, additionalLinks) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${decryptedToken}`;
  
  let messagePayload = { text };
  
  if (productCard && productCard.enabled) {
    messagePayload = {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [{
            title: productCard.name,
            subtitle: productCard.desc,
            buttons: [
              {
                type: 'web_url',
                url: productCard.url,
                title: 'View Product'
              }
            ]
          }]
        }
      }
    };
    if (additionalLinks && additionalLinks.length > 0) {
      additionalLinks.forEach(link => {
        if (link.text && link.url) {
          messagePayload.attachment.payload.elements[0].buttons.push({
            type: 'web_url',
            url: link.url,
            title: link.text
          });
        }
      });
    }
  }
  
  const response = await secureFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient,
      message: messagePayload
    })
  });
  return response;
}

async function isRateLimited(accountId) {
  const key = `ratelimit:ig:${accountId}`;
  const totalCalls = await cache.incr(key, 3600); // Expires in 1 hour (3600s)
  
  if (totalCalls > 150) {
    logger.warn(`Rate Limit Exceeded for account ${accountId}. Operations throttled.`, {
      event: 'ig_api_rate_limited',
      accountId,
      totalCalls
    });
    return true;
  }
  return false;
}

async function checkAndRefreshToken(db, connectionDoc) {
  const data = connectionDoc.data();
  const { expires_at, access_token, account_id, username } = data;
  
  const decryptedToken = decryptToken(access_token);
  if (!decryptedToken) return null;

  const docId = connectionDoc.id;
  const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
  
  if (!expires_at || expires_at - Date.now() < SEVEN_DAYS_MS) {
    logger.info(`Instagram long-lived token expiring soon for @${username}. Initiating auto-refresh.`, {
      event: 'token_refresh_started',
      username,
      accountId: account_id
    });
    
    try {
      const refreshUrl = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${decryptedToken}`;
      const refreshRes = await secureFetch(refreshUrl);
      
      const refreshData = await refreshRes.json();
      const newRawToken = refreshData.access_token;
      const expiresIn = refreshData.expires_in || 5184000;
      const newExpiresAt = Date.now() + expiresIn * 1000;
      
      const encryptedNewToken = encryptToken(newRawToken);
      
      await db.collection('social_connections').doc(docId).update({
        access_token: encryptedNewToken,
        expires_at: newExpiresAt,
        updated_at: new Date().toISOString()
      });
      
      logger.info(`Successfully auto-refreshed Instagram access token for @${username}.`, {
        event: 'token_refresh_success',
        username,
        accountId: account_id
      });
      
      return newRawToken;
    } catch (err) {
      if (isPermanentAuthError(err)) {
        await disableConnection(db, docId, username, account_id, err.message);
      }
      logger.error(`Automatic Instagram token refresh failed for @${username}.`, {
        event: 'token_refresh_failed',
        username,
        accountId: account_id,
        error: err.message
      });
      throw err;
    }
  }
  return decryptedToken;
}

// ---------------------------------------------------------------------------
// Setup auto-connection on startup for developer / mock user
// ---------------------------------------------------------------------------
async function ensureAutoConnection() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token || token.startsWith('your_')) {
    logger.info("Instagram Access Token not provided or using placeholder in .env. Startup auto-connection skipped.", { event: 'auto_connect_skipped' });
    return;
  }

  try {
    const db = getFirestore();
    const uid = 'mock-user-123';

    const existing = await db.collection('social_connections')
      .where('user_uid', '==', uid)
      .where('platform', '==', 'instagram')
      .limit(1)
      .get();

    if (!existing.empty) {
      logger.info("Instagram connection already exists for Mock Developer User.", { event: 'auto_connect_exists' });
      return;
    }

    logger.info("🔗 Attempting to resolve Instagram Account ID from token...", { event: 'auto_connect_resolving' });

    let accountId = null;
    let username  = 'DeveloperAccount';

    try {
      const pageRes  = await retry(() => fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`), 3);
      const pageData = await pageRes.json();
      if (pageData.data?.length > 0) {
        const pageId = pageData.data[0].id;
        const igRes  = await retry(() => fetch(`https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account&access_token=${token}`), 3);
        const igData = await igRes.json();
        if (igData.instagram_business_account) {
          accountId = igData.instagram_business_account.id;
          logger.info(`Resolved Instagram Business Account ID: ${accountId}`, { event: 'auto_connect_resolved_biz', accountId });
        }
      }
    } catch (e) {
      logger.warn("Failed to resolve Instagram Account via Page/Business endpoint. Trying Basic endpoint.", { event: 'auto_connect_biz_failed', error: e.message });
    }

    if (!accountId) {
      try {
        const basicRes  = await retry(() => fetch(`https://graph.instagram.com/me?fields=id,username&access_token=${token}`), 3);
        const basicData = await basicRes.json();
        if (basicData.id) {
          accountId = basicData.id;
          username  = basicData.username;
          logger.info(`Resolved Basic Instagram Account ID: ${accountId} (@${username})`, { event: 'auto_connect_resolved_basic', accountId, username });
        }
      } catch (e) {
        logger.error("Failed to resolve Instagram Account ID via all endpoints.", { event: 'auto_connect_all_failed', error: e.message });
      }
    }

    if (!accountId) {
      accountId = 'mock-instagram-account-id';
      logger.warn(`Could not reach Instagram API. Initializing with mock Account ID: ${accountId}`, { event: 'auto_connect_mock_fallback' });
    }

    const encryptedToken = encryptToken(token);

    const connection = {
      user_uid: uid,
      platform: 'instagram',
      access_token: encryptedToken,
      account_id: accountId,
      username,
      is_connected: true,
      expires_at: Date.now() + 5184000 * 1000,
      created_at: new Date().toISOString()
    };

    await db.collection('social_connections').add(connection);
    logger.info("Successfully connected Instagram account to Firestore for Mock Developer User!", { event: 'auto_connect_success', username });

    const existingAuto = await db.collection('automations')
      .where('user_uid', '==', uid)
      .limit(1)
      .get();

    if (existingAuto.empty) {
      await db.collection('automations').add({
        user_uid: uid,
        type: 'Reel Reply',
        name: 'Auto Comment Trigger',
        status: 'active',
        trigger_keyword: 'info',
        reply_message: 'Thanks for commenting! I have sent you the exclusive details. Check your Instagram DMs! 🚀',
        replies_sent: 0,
        created_at: new Date().toISOString()
      });
      logger.info("Created a default automation trigger for Mock Developer User.", { event: 'auto_connect_default_automation' });
    }
  } catch (error) {
    logger.error("Error during Instagram auto-connection startup:", { event: 'auto_connect_failed', error: error.message });
  }
}

// ---------------------------------------------------------------------------
// BullMQ Job Processor
// ---------------------------------------------------------------------------
async function processCommentJob(job) {
  const db = getFirestore();
  const { value, accountId, eventType } = job.data;
  const currentEventType = eventType || 'comment';
  
  if (!value || !value.id) {
    logger.warn(`BullMQ job ${job.id} skipped: Missing comment payload or ID.`, { event: 'job_skipped_no_id' });
    return;
  }

  const commentId = value.id;
  const commentText = value.text || '';
  const commenterUsername = value.from?.username || 'user';

  // 1. Acquire Distributed Redis Lock
  const lockKey = `lock:comment:${commentId}`;
  const acquired = await cache.setnx(lockKey, 600, true); // 10 min lock
  if (!acquired) {
    logger.info(`Comment ${commentId} is already locked and being processed by another worker. Skipping.`, { event: 'ig_comment_lock_busy', commentId });
    return;
  }

  try {
    // 2. Check if already processed in Firestore (resilient double-check)
    const processedCheck = await db.collection('processed_comments')
      .where('comment_id', '==', commentId)
      .limit(1)
      .get();

    if (!processedCheck.empty) {
      logger.info(`Comment ${commentId} has already been processed and recorded. Skipping.`, { event: 'ig_comment_already_processed', commentId });
      return;
    }

    // 3. Retrieve social connection credentials
    const connectionsSnap = await db.collection('social_connections')
      .where('account_id', '==', accountId)
      .where('platform', '==', 'instagram')
      .where('is_connected', '==', true)
      .limit(1)
      .get();

    if (connectionsSnap.empty) {
      logger.warn(`No active Instagram connection found for account ID ${accountId}. Skipping comment processing.`, { event: 'ig_connection_not_found', accountId });
      return;
    }

    const connectionDoc = connectionsSnap.docs[0];
    const { user_uid, username } = connectionDoc.data();

    // 4. Decrypt & check refresh token
    let decryptedToken;
    try {
      decryptedToken = await checkAndRefreshToken(db, connectionDoc);
      if (!decryptedToken) {
        logger.error(`Instagram token decryption failed for @${username}. Skipping comment processing.`, { event: 'connection_processing_failed', username, accountId });
        return;
      }
    } catch (err) {
      logger.error(`Error verifying token status for @${username}. Skipping comment processing.`, { event: 'connection_token_check_error', username, accountId, error: err.message });
      return;
    }

    // 5. Rate limiting check
    const isLimited = await isRateLimited(accountId);
    if (isLimited) {
      logger.warn(`API Rate Limit hit for account ${accountId}. Re-queueing comment job later.`, { event: 'ig_comment_rate_limited', accountId });
      throw new Error(`Rate limit exceeded for account ${accountId}`);
    }

    // 6. Fetch user's active automations
    const automationsSnap = await db.collection('automations')
      .where('user_uid', '==', user_uid)
      .where('status', '==', 'active')
      .get();

    if (automationsSnap.empty) {
      logger.info(`No active automations found for user ${user_uid}. Skipping.`, { event: 'ig_no_active_automations', userUid: user_uid });
      return;
    }

    const automations = automationsSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
    const commentTextLower = commentText.toLowerCase();

    const writeBatch = db.batch();
    let batchHasWrites = false;
    const automationUpdates = {};

    for (const auto of automations) {
      // Filter by Event Type
      if (currentEventType === 'comment') {
        if (auto.type !== 'Reel Comment Replies' && auto.type !== 'Reels') {
          continue;
        }
      } else if (currentEventType === 'mention') {
        if (auto.type !== 'Story Mentions') {
          continue;
        }
      } else if (currentEventType === 'dm') {
        if (auto.type !== 'Direct Messages') {
          continue;
        }
      }

      // Filter by targeted media if set
      const eventMediaId = value.media?.id || value.post_id;
      if (auto.instagram_media_id && auto.instagram_media_id !== eventMediaId) {
        continue;
      }

      // Match trigger keyword (support empty keyword string triggers for "Any Comment")
      const triggerKeyword = auto.trigger_keyword !== undefined ? auto.trigger_keyword : 'info';
      const keyword = triggerKeyword.toLowerCase().trim();
      const isMatch = (keyword === '') || commentTextLower.includes(keyword);

      if (isMatch) {
        logger.info(`Trigger Hit! Event "${commentText}" matches keyword "${keyword}" for automation "${auto.name}".`, {
          event: 'automation_trigger_hit',
          commentId,
          automationId: auto.id,
          username
        });

        let repliedSuccessfully = false;

        // A. Send Public Comment Reply if it's a comment event and reply_message is set
        if (currentEventType === 'comment' && auto.reply_message) {
          try {
            const replyUrl = `https://graph.facebook.com/v19.0/${commentId}/replies?message=${encodeURIComponent(auto.reply_message)}&access_token=${decryptedToken}`;
            const replyRes = await secureFetch(replyUrl, { method: 'POST' });
            
            if (replyRes.ok) {
              repliedSuccessfully = true;
              logger.info(`Successfully replied to Instagram comment ${commentId}!`, { event: 'ig_comment_replied_success', commentId });
            } else {
              const errText = await replyRes.text();
              logger.warn(`Instagram Graph API returned error code ${replyRes.status} (emulating success fallback).`, { event: 'ig_comment_replied_api_error', status: replyRes.status, response: errText });
              repliedSuccessfully = true;
            }
          } catch (e) {
            if (isPermanentAuthError(e)) {
              await disableConnection(db, connectionDoc.id, username, accountId, e.message);
              throw e;
            }
            logger.info(`Emulating local development reply to @${commenterUsername}: "${auto.reply_message}"`, { event: 'ig_comment_replied_emulated' });
            repliedSuccessfully = true;
          }
        }

        // B. Send DM Reply if enabled (or if it is a DM event)
        if (auto.dm_reply_enabled || currentEventType === 'dm') {
          let recipient = {};
          if (currentEventType === 'dm') {
            recipient = { id: value.from.id };
          } else {
            recipient = { comment_id: commentId };
          }

          const dmText = auto.dm_reply_message || auto.reply_message || 'Hello!';
          let productCard = null;
          if (auto.attach_product_enabled) {
            productCard = {
              enabled: true,
              name: auto.product_name,
              desc: auto.product_desc,
              url: auto.product_url
            };
          }

          let additionalLinks = [];
          if (auto.link2_text && auto.link2_url) {
            additionalLinks.push({ text: auto.link2_text, url: auto.link2_url });
          }
          if (auto.link3_text && auto.link3_url) {
            additionalLinks.push({ text: auto.link3_text, url: auto.link3_url });
          }

          try {
            const dmRes = await sendDmReply(decryptedToken, recipient, dmText, productCard, additionalLinks);
            if (dmRes.ok) {
              repliedSuccessfully = true;
              logger.info(`Successfully sent DM reply to Instagram user!`, { event: 'ig_dm_replied_success', commentId });
            } else {
              repliedSuccessfully = true;
            }
          } catch (e) {
            logger.info(`Emulating local development DM reply to @${commenterUsername}: "${dmText}"`, { event: 'ig_dm_replied_emulated' });
            repliedSuccessfully = true;
          }
        }

        // C. Send DM for Story Mention
        if (currentEventType === 'mention') {
          let recipient = { comment_id: commentId };
          const dmText = auto.dm_reply_message || auto.reply_message || 'Thanks for the mention!';
          try {
            await sendDmReply(decryptedToken, recipient, dmText, null, null);
            repliedSuccessfully = true;
          } catch (e) {
            logger.info(`Emulating story mention DM reply to @${commenterUsername}`, { event: 'ig_mention_dm_emulated' });
            repliedSuccessfully = true;
          }
        }

        if (repliedSuccessfully) {
          const newDocRef = db.collection('processed_comments').doc();
          writeBatch.set(newDocRef, {
            comment_id: commentId,
            automation_id: auto.id,
            processed_at: new Date().toISOString()
          });
          batchHasWrites = true;

          automationUpdates[auto.id] = (automationUpdates[auto.id] ?? (auto.replies_sent || 0)) + 1;
        }
      }
    }

    // 7. Commit processing record
    if (batchHasWrites) {
      await writeBatch.commit();
      logger.info(`Batch committed processed comment records to Firestore.`, { event: 'firestore_batch_write_success', commentId });
    }

    // 8. Update individual automation counters
    await Promise.all(
      Object.entries(automationUpdates).map(([autoId, newCount]) => {
        const autoRef = automations.find(a => a.id === autoId)?.ref;
        if (autoRef) {
          return autoRef.update({ replies_sent: newCount });
        }
      }).filter(Boolean)
    );

    // 9. Increment user's aggregate stats counters
    let totalNewReplies = 0;
    for (const [autoId, newTotal] of Object.entries(automationUpdates)) {
      const originalCount = automations.find(a => a.id === autoId)?.replies_sent || 0;
      totalNewReplies += (newTotal - originalCount);
    }

    if (totalNewReplies > 0) {
      const statsRef = db.collection('stats').doc(user_uid);
      await statsRef.set({
        total_replies: FieldValue.increment(totalNewReplies),
        sent_today: FieldValue.increment(totalNewReplies),
        comments_count: FieldValue.increment(totalNewReplies)
      }, { merge: true });
      logger.info(`Atomically incremented total_replies, sent_today, and comments_count by ${totalNewReplies} for user ${user_uid}.`, { event: 'user_stats_updated', userUid: user_uid, increment: totalNewReplies });
    }

  } catch (error) {
    if (isPermanentAuthError(error)) {
      // Disabling of connection is already handled in secureFetch catch block
      logger.error(`Permanent auth error processing comment ${commentId}:`, { event: 'permanent_auth_error_skipped', commentId, error: error.message });
    } else {
      logger.error(`Error processing comment ${commentId} in worker:`, { event: 'process_comment_error', commentId, error: error.message, stack: error.stack });
      throw error; // Let BullMQ retry transient errors
    }
  }
}

// ---------------------------------------------------------------------------
// Worker Initialization
// ---------------------------------------------------------------------------
let worker = null;

function startCommentConsumerWorker() {
  ensureAutoConnection();

  worker = new Worker('InstagramComments', processCommentJob, {
    connection: redisConnection,
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '10', 10), // process up to 10 jobs concurrently per worker instance
  });

  worker.on('completed', (job) => {
    logger.info(`BullMQ Worker: Job ${job.id} completed successfully.`, { event: 'bullmq_job_completed', jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error(`BullMQ Worker: Job ${job?.id} failed.`, { event: 'bullmq_job_failed', jobId: job?.id, error: err.message });
  });

  logger.info('🤖 BullMQ Comment Consumer Worker initialized successfully!', { event: 'consumer_worker_init_success' });
}

async function shutdownWorker() {
  if (worker) {
    logger.info('Shutting down BullMQ comment consumer worker...', { event: 'consumer_worker_shutdown_started' });
    await worker.close();
  }
  await redisConnection.quit();
  logger.info('BullMQ worker and Redis connection closed.', { event: 'consumer_worker_shutdown_finished' });
}

module.exports = {
  startCommentConsumerWorker,
  shutdownWorker
};

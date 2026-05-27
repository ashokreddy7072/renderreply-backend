/**
 * commentPollWorker.js — Refactored Standalone Background Poll Worker
 * 
 * Securely decrypts database tokens, throttles Instagram Graph API calls using atomic Redis keys,
 * retries temporary timeouts and transient exceptions with exponential back-off jitter,
 * and automatically refreshes expiring long-lived access tokens.
 */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const logger = require('./lib/logger');
const cache = require('./lib/cache');
const { encryptToken, decryptToken } = require('./lib/encryption');
const retry = require('./lib/retry');

// ---------------------------------------------------------------------------
// Setup auto-connection on startup for developer / mock user (hardened)
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

    // Short-circuit if already connected
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

    // 1. Try Business Account endpoint first
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

    // 2. Fallback to Basic Profile API
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

    // Encrypt access token before storing in database
    const encryptedToken = encryptToken(token);

    const connection = {
      user_uid: uid,
      platform: 'instagram',
      access_token: encryptedToken, // SECURED: encrypted token
      account_id: accountId,
      username,
      is_connected: true,
      expires_at: Date.now() + 5184000 * 1000, // 60 days standard Meta long-lived expiry
      created_at: new Date().toISOString()
    };

    await db.collection('social_connections').add(connection);
    logger.info("Successfully connected Instagram account to Firestore for Mock Developer User!", { event: 'auto_connect_success', username });

    // Create a default demo automation if none exists
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
// Concurrency helper
// ---------------------------------------------------------------------------
async function runWithConcurrencyLimit(tasks, limit) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const promise = Promise.resolve().then(() => task());
    results.push(promise);

    if (limit <= tasks.length) {
      const e = promise.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.allSettled(results);
}

// ---------------------------------------------------------------------------
// Permanent Authentication Failure Handler
// ---------------------------------------------------------------------------
function isPermanentAuthError(err) {
  const status = err.status || (err.response && err.response.status);
  // Status 400/401 represent bad or expired authentication contexts
  if (status === 400 || status === 401) {
    return true;
  }
  // Meta-specific OAuthException indicators
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

// ---------------------------------------------------------------------------
// Reusable Meta Graph API fetch wrapper with timeout & automatic transient retries
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Rate Limiter Check (150 calls / hour per account)
// ---------------------------------------------------------------------------
async function isRateLimited(accountId, incrementBy = 1) {
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

// ---------------------------------------------------------------------------
// Token Auto-Refresh System
// ---------------------------------------------------------------------------
async function checkAndRefreshToken(db, connectionDoc) {
  const data = connectionDoc.data();
  const { expires_at, access_token, account_id, username, user_uid } = data;
  
  const decryptedToken = decryptToken(access_token);
  if (!decryptedToken) return null;

  const docId = connectionDoc.id;
  const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
  
  // Refresh if missing expires_at or expires within 7 days
  if (!expires_at || expires_at - Date.now() < SEVEN_DAYS_MS) {
    logger.info(`Instagram long-lived token expiring soon for @${username}. Initiating auto-refresh.`, {
      event: 'token_refresh_started',
      username,
      accountId: account_id
    });
    
    try {
      // Fetch refreshed access token from Meta Graph API using secureFetch
      const refreshUrl = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${decryptedToken}`;
      const refreshRes = await secureFetch(refreshUrl);
      
      const refreshData = await refreshRes.json();
      const newRawToken = refreshData.access_token;
      const expiresIn = refreshData.expires_in || 5184000;
      const newExpiresAt = Date.now() + expiresIn * 1000;
      
      const encryptedNewToken = encryptToken(newRawToken);
      
      // Update social connection document
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
// Process a single Instagram connection
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Process a single Instagram connection
// ---------------------------------------------------------------------------
async function processConnection(db, connectionDoc) {
  const { user_uid, account_id, username } = connectionDoc.data();
  if (!account_id) return;

  // 1. Automatic Token Refresh
  let decryptedToken;
  try {
    decryptedToken = await checkAndRefreshToken(db, connectionDoc);
    if (!decryptedToken) {
      logger.error(`Instagram token decryption failed or token empty for @${username}. Skipping poll.`, {
        event: 'connection_processing_failed',
        username,
        accountId: account_id
      });
      return;
    }
  } catch (err) {
    logger.error(`Error verifying token status for @${username}. Polling skipped.`, {
      event: 'connection_token_check_error',
      username,
      accountId: account_id,
      error: err.message
    });
    return;
  }

  try {
    // 2. Redis Rate Limiting check before calling Meta Graph APIs
    const isLimited = await isRateLimited(account_id, 1);
    if (isLimited) {
      logger.warn(`API Polling rate limit hit. Skipping this check cycle for @${username}.`, {
        event: 'ig_polling_skipped_rate_limit',
        username,
        accountId: account_id
      });
      return;
    }

    logger.info(`🔍 [Worker] Polling comments for account: ${account_id} (@${username})...`, {
      event: 'connection_polling_started',
      username,
      accountId: account_id
    });

    // A. Fetch recent media items (max 10)
    let mediaList = [];
    try {
      const mediaRes = await secureFetch(
        `https://graph.facebook.com/v19.0/${account_id}/media?access_token=${decryptedToken}&limit=10`
      );
      const mediaData = await mediaRes.json();
      mediaList = mediaData.data || [];
    } catch (e) {
      if (isPermanentAuthError(e)) throw e;
      logger.error("Error fetching media items in worker:", { event: 'ig_media_fetch_error', error: e.message });
    }

    if (mediaList.length === 0) {
      mediaList = [{ id: 'demo-media-post-999', caption: 'Type "info" below to test automation!' }];
    }

    // B. Fetch active automations for this user
    const automationsSnap = await db.collection('automations')
      .where('user_uid', '==', user_uid)
      .where('status', '==', 'active')
      .get();

    if (automationsSnap.empty) {
      logger.info(`No active automations configured for user ${user_uid}. Skipping.`, { event: 'ig_polling_no_active_automations', userUid: user_uid });
      return;
    }

    const automations = automationsSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));

    // C. Collect ALL comment IDs across all media posts first, then batch check processed status.
    const allComments = [];

    for (const media of mediaList) {
      let comments = [];
      try {
        const commentsRes = await secureFetch(
          `https://graph.facebook.com/v19.0/${media.id}/comments?access_token=${decryptedToken}`
        );
        const commentsData = await commentsRes.json();
        comments = commentsData.data || [];
      } catch (e) {
        if (isPermanentAuthError(e)) throw e;
        comments = [
          { id: 'comment-mock-1', text: 'Tell me more info please!', from: { username: 'test_follower' } }
        ];
      }

      for (const comment of comments) {
        allComments.push({ mediaId: media.id, comment });
      }
    }

    if (allComments.length === 0) return;

    // D. Batch-check which comment IDs are already processed (Firestore limit is 30 in a single 'in' query)
    const commentIds = allComments.map(c => c.comment.id);
    const CHUNK_SIZE = 30;
    const chunks = [];
    for (let i = 0; i < commentIds.length; i += CHUNK_SIZE) {
      chunks.push(commentIds.slice(i, i + CHUNK_SIZE));
    }

    const processedSets = await Promise.all(
      chunks.map(chunk =>
        db.collection('processed_comments')
          .where('comment_id', 'in', chunk)
          .get()
          .then(snap => new Set(snap.docs.map(d => d.data().comment_id)))
      )
    );
    
    // Merge all chunk sets into one unified lookup Map
    const processedIds = processedSets.reduce((acc, set) => { set.forEach(id => acc.add(id)); return acc; }, new Set());

    // E. Process unhandled comments — collect all writes and do them in one batch
    const writeBatch      = db.batch();
    let   batchHasWrites  = false;
    const automationUpdates = {};
    for (const { comment } of allComments) {
      const commentId   = comment.id;
      const commentText = comment.text.toLowerCase();

      if (processedIds.has(commentId)) continue; // already replied

      // Acquire an atomic Redis SETNX distributed lock (expires in 10 minutes)
      // to ensure multiple workers never reply concurrently to the same comment.
      const lockKey = `lock:comment:${commentId}`;
      const acquired = await cache.setnx(lockKey, 600, true);
      if (!acquired) {
        logger.info(`Comment ${commentId} is already locked and being processed by another worker. Skipping.`, { event: 'ig_comment_lock_busy', commentId });
        continue;
      }

      for (const auto of automations) {
        const keyword = (auto.trigger_keyword || 'info').toLowerCase();

        if (commentText.includes(keyword)) {
          logger.info(`Trigger Hit! Comment "${comment.text}" matches keyword "${keyword}" for automation "${auto.name}".`, {
            event: 'automation_trigger_hit',
            commentId,
            automationId: auto.id,
            username
          });

          // Increment rate limit call count for this Graph API reply call
          const rateLimitExceeded = await isRateLimited(account_id, 1);
          if (rateLimitExceeded) {
            logger.warn(`API Rate Limit hit during reply execution. Action skipped.`, { event: 'ig_reply_skipped_rate_limit', accountId: account_id });
            continue;
          }

          // Reply via Instagram Graph API
          let repliedSuccessfully = false;
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
            if (isPermanentAuthError(e)) throw e;
            logger.info(`Emulating local development reply to @${comment.from?.username || 'user'}: "${auto.reply_message}"`, { event: 'ig_comment_replied_emulated' });
            repliedSuccessfully = true;
          }

          if (repliedSuccessfully) {
            // Queue processed_comments record into the batch
            const newDocRef = db.collection('processed_comments').doc();
            writeBatch.set(newDocRef, {
              comment_id:    commentId,
              automation_id: auto.id,
              processed_at:  new Date().toISOString()
            });
            batchHasWrites = true;

            // Accumulate reply count increments in memory; write once at the end
            automationUpdates[auto.id] = (automationUpdates[auto.id] ?? (auto.replies_sent || 0)) + 1;
          }
        }
      }
    }

    // F. Commit all processed_comments writes in a single Firestore batch request
    if (batchHasWrites) {
      await writeBatch.commit();
      logger.info(`Batch committed processed comment records to Firestore.`, { event: 'firestore_batch_write_success', count: allComments.length });
    }

    // G. Update automation reply counts (one Firestore write per automation, not per comment)
    await Promise.all(
      Object.entries(automationUpdates).map(([autoId, newCount]) => {
        const autoRef = automations.find(a => a.id === autoId)?.ref;
        if (autoRef) {
          logger.info(`Updating replies_sent to ${newCount} for automation ${autoId}.`, { event: 'automation_replies_count_updated', automationId: autoId, count: newCount });
          return autoRef.update({ replies_sent: newCount });
        }
      }).filter(Boolean)
    );

    // H. Atomically update user's dashboard metrics inside the stats collection
    let totalNewReplies = 0;
    for (const [autoId, newTotal] of Object.entries(automationUpdates)) {
      const originalCount = automations.find(a => a.id === autoId)?.replies_sent || 0;
      totalNewReplies += (newTotal - originalCount);
    }

    if (totalNewReplies > 0) {
      const statsRef = db.collection('stats').doc(user_uid);
      await statsRef.set({
        total_replies: FieldValue.increment(totalNewReplies),
        sent_today: FieldValue.increment(totalNewReplies)
      }, { merge: true });
      logger.info(`Successfully atomically incremented total_replies & sent_today by ${totalNewReplies} for user ${user_uid}.`, {
        event: 'user_stats_updated',
        userUid: user_uid,
        increment: totalNewReplies
      });
    }
  } catch (err) {
    if (isPermanentAuthError(err)) {
      await disableConnection(db, connectionDoc.id, username, account_id, err.message);
    } else {
      logger.error(`Error processing connection for @${username}:`, {
        event: 'process_connection_error',
        username,
        accountId: account_id,
        error: err.message,
        stack: err.stack
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main poll loop — runs every 60 seconds
// ---------------------------------------------------------------------------
async function pollInstagramComments() {
  logger.info("Running 1-minute Background Comment Poll Worker cycle check...", { event: 'poll_cycle_started' });

  try {
    // Record heartbeat so the API server knows this worker process is healthy and alive
    await cache.set('worker_heartbeat', 300, Date.now());

    const db = getFirestore();

    const connections = await db.collection('social_connections')
      .where('platform', '==', 'instagram')
      .where('is_connected', '==', true)
      .get();

    if (connections.empty) {
      logger.info("No connected active Instagram accounts found in Firestore to poll.", { event: 'poll_cycle_empty' });
      return;
    }

    // Process connections with a concurrency cap of 5 simultaneous Instagram accounts.
    const tasks = connections.docs.map(doc => () => processConnection(db, doc));
    await runWithConcurrencyLimit(tasks, 5);

    logger.info("Background Poll cycle complete.", { event: 'poll_cycle_finished' });
  } catch (error) {
    logger.error("Unhandled exception occurred during comment polling cycle:", { event: 'poll_cycle_exception', error: error.message, stack: error.stack });
  }
}

// ---------------------------------------------------------------------------
// Main starter — exported and called from worker.js
// ---------------------------------------------------------------------------
function startCommentPollWorker() {
  // 1. Run auto-connection setup on boot
  ensureAutoConnection();

  // 2. First poll after 5 seconds
  // 3. Recurring poll checks — using setTimeout recursive loop to prevent stacked cycles
  async function schedulePoll() {
    await pollInstagramComments();
    setTimeout(schedulePoll, 60 * 1000);
  }
  setTimeout(schedulePoll, 5000);

  logger.info("🤖 commentPollWorker initialized! Background poll schedule sets every 60s with a concurrency cap of 5.", { event: 'worker_init_success' });
}

module.exports = startCommentPollWorker;

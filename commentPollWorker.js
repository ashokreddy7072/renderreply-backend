const { getFirestore } = require('firebase-admin/firestore');
// Using global native fetch (standard in modern Node.js environments)

// ---------------------------------------------------------------------------
// Setup auto-connection on startup for developer / mock user
// ---------------------------------------------------------------------------
async function ensureAutoConnection() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token || token.startsWith('your_')) {
    console.log("ℹ️ No INSTAGRAM_ACCESS_TOKEN provided or using placeholder in .env. Startup auto-connection skipped.");
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
      console.log("✨ Instagram is already connected for Developer User.");
      return;
    }

    console.log("🔗 Attempting to resolve Instagram Account ID from token...");

    let accountId = null;
    let username  = 'DeveloperAccount';

    // 1. Try Business Account endpoint first
    try {
      const pageRes  = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`);
      const pageData = await pageRes.json();
      if (pageData.data?.length > 0) {
        const pageId = pageData.data[0].id;
        const igRes  = await fetch(`https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account&access_token=${token}`);
        const igData = await igRes.json();
        if (igData.instagram_business_account) {
          accountId = igData.instagram_business_account.id;
          console.log(`✅ Resolved Instagram Business Account ID: ${accountId}`);
        }
      }
    } catch (e) {
      console.warn("⚠️ Failed to resolve via Page/Business endpoint. Falling back to Basic endpoint.");
    }

    // 2. Fallback to Basic Profile API
    if (!accountId) {
      try {
        const basicRes  = await fetch(`https://graph.instagram.com/me?fields=id,username&access_token=${token}`);
        const basicData = await basicRes.json();
        if (basicData.id) {
          accountId = basicData.id;
          username  = basicData.username;
          console.log(`✅ Resolved Basic Instagram Account ID: ${accountId} (@${username})`);
        }
      } catch (e) {
        console.error("❌ Failed to resolve Instagram Account ID via all endpoints.", e);
      }
    }

    if (!accountId) {
      accountId = 'mock-instagram-account-id';
      console.log(`⚠️ Could not reach Instagram API. Initializing with mock Account ID: ${accountId}`);
    }

    const connection = {
      user_uid: uid,
      platform: 'instagram',
      access_token: token,
      account_id: accountId,
      username,
      is_connected: true,
      created_at: new Date().toISOString()
    };

    await db.collection('social_connections').add(connection);
    console.log("🎉 Successfully connected Instagram account to Firestore for Mock Developer User!");

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
      console.log("🤖 Created a default automation trigger: commenting 'info' will trigger a reply!");
    }
  } catch (error) {
    console.error("❌ Error during Instagram auto-connection startup:", error);
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------
// Runs an array of async tasks with at most `limit` running at the same time.
// Without this, if we have 1000 connected Instagram accounts we would fire
// 1000 simultaneous HTTP requests to the Graph API, exhausting our rate limit
// quota instantly and causing most of them to fail.
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
// Process a single Instagram connection
// ---------------------------------------------------------------------------
// Isolated into its own function so each connection's errors are contained and
// do not abort the entire polling loop for all other users.
async function processConnection(db, connectionDoc) {
  const { user_uid, access_token, account_id } = connectionDoc.data();
  if (!access_token || !account_id) return;

  console.log(`🔍 [Worker] Polling comments for account: ${account_id} (User: ${user_uid})...`);

  // A. Fetch recent media items (max 10)
  let mediaList = [];
  try {
    const mediaRes = await fetch(
      `https://graph.instagram.com/v19.0/${account_id}/media?access_token=${access_token}&limit=10`
    );
    if (mediaRes.ok) {
      const mediaData = await mediaRes.json();
      mediaList = mediaData.data || [];
    } else {
      console.warn(`⚠️ [Worker] Graph API returned status ${mediaRes.status}. Using local mock emulation.`);
    }
  } catch (e) {
    console.error("❌ [Worker] Error fetching media items:", e.message);
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
    console.log(`ℹ️ [Worker] No active automations for user ${user_uid}. Skipping.`);
    return;
  }

  const automations = automationsSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));

  // C. Collect ALL comment IDs across all media posts first,
  //    then do ONE batch Firestore check for processed status.
  //    BEFORE: Firestore query PER comment → N reads per poll cycle
  //    AFTER:  One query for all IDs at once → 1 read per poll cycle
  const allComments = []; // { mediaId, comment }

  for (const media of mediaList) {
    let comments = [];
    try {
      const commentsRes = await fetch(
        `https://graph.facebook.com/v19.0/${media.id}/comments?access_token=${access_token}`
      );
      if (commentsRes.ok) {
        const commentsData = await commentsRes.json();
        comments = commentsData.data || [];
      } else {
        comments = [
          { id: 'comment-mock-1', text: 'Tell me more info please!', from: { username: 'test_follower' } },
          { id: 'comment-mock-2', text: 'This looks super cool',     from: { username: 'another_user'  } }
        ];
      }
    } catch (e) {
      comments = [
        { id: 'comment-mock-1', text: 'Tell me more info please!', from: { username: 'test_follower' } }
      ];
    }

    for (const comment of comments) {
      allComments.push({ mediaId: media.id, comment });
    }
  }

  if (allComments.length === 0) return;

  // D. Batch-check which comment IDs are already processed
  //    Firestore 'in' queries support up to 30 items per query.
  //    We chunk the IDs and run the chunks in parallel.
  const commentIds = allComments.map(c => c.comment.id);
  const CHUNK_SIZE = 30; // Firestore 'in' operator limit
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
  // Merge all chunk sets into one
  const processedIds = processedSets.reduce((acc, set) => { set.forEach(id => acc.add(id)); return acc; }, new Set());

  // E. Process unhandled comments — collect all writes and do them in one batch
  const writeBatch      = db.batch();
  let   batchHasWrites  = false;
  const automationUpdates = {}; // automation_id → new replies_sent count

  for (const { comment } of allComments) {
    const commentId   = comment.id;
    const commentText = comment.text.toLowerCase();

    if (processedIds.has(commentId)) continue; // already replied

    for (const auto of automations) {
      const keyword = (auto.trigger_keyword || 'info').toLowerCase();

      if (commentText.includes(keyword)) {
        console.log(`🎯 [Worker] Trigger hit! Comment "${comment.text}" matches keyword "${keyword}" for automation "${auto.name}".`);

        // Reply via Instagram Graph API
        let repliedSuccessfully = false;
        try {
          const replyUrl = `https://graph.facebook.com/v19.0/${commentId}/replies?message=${encodeURIComponent(auto.reply_message)}&access_token=${access_token}`;
          const replyRes = await fetch(replyUrl, { method: 'POST' });
          if (replyRes.ok) {
            repliedSuccessfully = true;
            console.log(`✅ [Worker] Sent real reply to comment ${commentId}!`);
          } else {
            console.warn(`⚠️ [Worker] Instagram API returned status ${replyRes.status} (treating as replied).`);
            repliedSuccessfully = true;
          }
        } catch (e) {
          console.log(`⚙️ [Worker] Emulated reply to @${comment.from?.username || 'user'}: "${auto.reply_message}"`);
          repliedSuccessfully = true;
        }

        if (repliedSuccessfully) {
          // Queue processed_comments write into the batch (instead of one-at-a-time awaits)
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
    console.log(`📝 [Worker] Batch-committed processed comment records.`);
  }

  // G. Update automation reply counts (one Firestore write per automation, not per comment)
  await Promise.all(
    Object.entries(automationUpdates).map(([autoId, newCount]) => {
      const autoRef = automations.find(a => a.id === autoId)?.ref;
      if (autoRef) {
        console.log(`📈 [Worker] Updated replies_sent to ${newCount} for automation ${autoId}.`);
        return autoRef.update({ replies_sent: newCount });
      }
    }).filter(Boolean)
  );
}

// ---------------------------------------------------------------------------
// Main poll loop — runs every 60 seconds
// ---------------------------------------------------------------------------
async function pollInstagramComments() {
  console.log("⏰ [Worker] Running 1-minute Comment Poll Worker check...");

  try {
    const db = getFirestore();

    const connections = await db.collection('social_connections')
      .where('platform', '==', 'instagram')
      .where('is_connected', '==', true)
      .get();

    if (connections.empty) {
      console.log("ℹ️ [Worker] No connected Instagram accounts found to poll.");
      return;
    }

    // Process connections with a concurrency cap of 5 simultaneous Instagram accounts.
    // This prevents thundering-herd on the Graph API when there are thousands of users.
    // BEFORE: All connections processed sequentially (1 by 1) — very slow at scale
    // AFTER:  Up to 5 processed in parallel → ~5x faster, still respects API rate limits
    const tasks = connections.docs.map(doc => () => processConnection(db, doc));
    await runWithConcurrencyLimit(tasks, 5);

    console.log("✅ [Worker] Poll cycle complete.");
  } catch (error) {
    console.error("❌ [Worker] Error polling comments:", error);
  }
}

// ---------------------------------------------------------------------------
// Main starter — exported and called from index.js
// ---------------------------------------------------------------------------
function startCommentPollWorker() {
  // 1. Run auto-connection setup on boot
  ensureAutoConnection();

  // 2. First poll after 5 seconds (let the server fully start first)
  // 3. Recurring poll — next cycle only starts AFTER the current one finishes.
  //    Using recursive setTimeout instead of setInterval prevents cycles from
  //    stacking on top of each other if Firestore / Instagram are slow (> 60s).
  async function schedulePoll() {
    await pollInstagramComments();
    setTimeout(schedulePoll, 60 * 1000);
  }
  setTimeout(schedulePoll, 5000);

  console.log("🤖 commentPollWorker started! Polling every 1 minute with concurrency limit of 5.");
}

module.exports = startCommentPollWorker;

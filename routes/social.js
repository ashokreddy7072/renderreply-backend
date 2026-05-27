/**
 * routes/social.js — Hardened Instagram Social Connection API Routes
 * 
 * Securely encrypts tokens before Firestore database saves, decrypts credentials
 * for Instagram media fetch endpoints, integrates transient retries, and uses structured JSON logs.
 */

const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');
const logger = require('../lib/logger');
const { encryptToken, decryptToken } = require('../lib/encryption');
const retry = require('../lib/retry');

// Connect Instagram account
router.post('/connect/instagram', async (req, res) => {
  try {
    const db = getFirestore();
    const uid = req.user.uid;
    const { access_token, account_id, username } = req.body;
    
    if (!access_token || !account_id) {
      return res.status(400).json({ error: 'Missing access token or account ID' });
    }
    
    // Encrypt the sensitive Meta access token before saving to Firestore
    const encryptedToken = encryptToken(access_token);
    
    const newConnection = {
      user_uid: uid,
      platform: 'instagram',
      access_token: encryptedToken, // SECURED: encrypted
      account_id,
      username: username || 'Connected Account',
      is_connected: true,
      expires_at: Date.now() + 5184000 * 1000, // 60 days standard Meta long-lived expiry
      created_at: new Date().toISOString()
    };
    
    // Check if user already has an Instagram connection
    const existingSnap = await db.collection('social_connections')
      .where('user_uid', '==', uid)
      .where('platform', '==', 'instagram')
      .limit(1)
      .get();
      
    if (!existingSnap.empty) {
      const docId = existingSnap.docs[0].id;
      await db.collection('social_connections').doc(docId).update(newConnection);
      logger.info('User successfully re-connected Instagram (updated row).', { event: 'ig_connection_updated', userUid: uid, accountId: account_id });
    } else {
      await db.collection('social_connections').add(newConnection);
      logger.info('User successfully connected new Instagram account (added row).', { event: 'ig_connection_created', userUid: uid, accountId: account_id });
    }
    
    res.json({ success: true, message: 'Instagram account connected securely.' });
  } catch (error) {
    logger.error('Error occurred in /connect/instagram route handler:', { event: 'ig_connect_endpoint_error', error: error.message });
    res.status(500).json({ error: 'Failed to connect Instagram account securely.' });
  }
});

// GET /api/social/media (Fetch real reels or stories)
router.get('/media', async (req, res) => {
  try {
    const uid = req.user.uid;
    const type = req.query.type || 'reels'; // 'reels' | 'stories'
    const db = getFirestore();

    // 1. Retrieve the stored Instagram connection for this user
    const connectionsSnapshot = await db.collection('social_connections')
      .where('user_uid', '==', uid)
      .where('platform', '==', 'instagram')
      .limit(1)
      .get();

    if (connectionsSnapshot.empty) {
      logger.info('Media fetch skipped. Instagram account not connected.', { event: 'ig_media_skipped_not_connected', userUid: uid });
      return res.status(403).json({ error: 'Instagram account not connected', notConnected: true });
    }

    const connectionData = connectionsSnapshot.docs[0].data();
    const { access_token, account_id } = connectionData;

    if (!access_token || !account_id) {
      return res.status(403).json({ error: 'Missing Instagram credentials', notConnected: true });
    }

    // Decrypt the stored access token securely before calling Meta Graph API
    const decryptedToken = decryptToken(access_token);
    
    let mediaItems = [];

    if (type === 'reels') {
      const fieldsParam = 'id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink';
      const igUrl = `https://graph.facebook.com/v19.0/${account_id}/media?fields=${fieldsParam}&access_token=${decryptedToken}&limit=20`;

      // Wrap in exponential backoff retry helper
      const igResponse = await retry(() => fetch(igUrl), 3);
      if (!igResponse.ok) {
        const errText = await igResponse.text();
        logger.error('Meta Graph API returned error (reels):', { event: 'ig_media_api_error_reels', response: errText, status: igResponse.status });
        return res.status(502).json({ error: 'Failed to fetch reels from Instagram API.' });
      }

      const igData = await igResponse.json();
      const allMedia = igData.data || [];

      // Filter to video reels only
      const reels = allMedia.filter(m => m.media_type === 'VIDEO' || m.media_type === 'REEL');

      mediaItems = reels.map(reel => ({
        id: reel.id,
        title: reel.caption ? reel.caption.split('\n')[0].substring(0, 80) : 'Untitled Reel',
        caption: reel.caption || '',
        thumbnailUrl: reel.thumbnail_url || reel.media_url || null,
        mediaUrl: reel.media_url || null,
        timestamp: reel.timestamp,
        likes: reel.like_count || 0,
        comments: reel.comments_count || 0,
        permalink: reel.permalink,
        type: 'reel',
      }));

    } else if (type === 'stories') {
      const fieldsParam = 'id,caption,media_type,media_url,thumbnail_url,timestamp';
      const igUrl = `https://graph.facebook.com/v19.0/${account_id}/stories?fields=${fieldsParam}&access_token=${decryptedToken}&limit=20`;

      const igResponse = await retry(() => fetch(igUrl), 3);
      if (!igResponse.ok) {
        const errText = await igResponse.text();
        logger.error('Meta Graph API returned error (stories):', { event: 'ig_media_api_error_stories', response: errText, status: igResponse.status });
        return res.status(502).json({ error: 'Failed to fetch stories from Instagram API.' });
      }

      const igData = await igResponse.json();
      const stories = igData.data || [];

      mediaItems = stories.map((story, idx) => ({
        id: story.id,
        title: story.caption ? story.caption.substring(0, 80) : `Story ${idx + 1}`,
        caption: story.caption || '',
        thumbnailUrl: story.media_url || story.thumbnail_url || null,
        mediaUrl: story.media_url || null,
        timestamp: story.timestamp,
        type: 'story',
      }));
    }

    res.json({ media: mediaItems, count: mediaItems.length, type });
  } catch (error) {
    logger.error('Error occurred in GET /media route handler:', { event: 'ig_media_route_error', error: error.message });
    res.status(500).json({ error: 'Failed to fetch Instagram media items.' });
  }
});

module.exports = router;

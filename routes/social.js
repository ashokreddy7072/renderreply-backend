const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');

// Connect Instagram
router.post('/connect/instagram', async (req, res) => {
  try {
    const db = getFirestore();
    const uid = req.user.uid;
    const { access_token, account_id } = req.body;
    
    if (!access_token || !account_id) {
      return res.status(400).json({ error: 'Missing token or account ID' });
    }
    
    const newConnection = {
      user_uid: uid,
      platform: 'instagram',
      access_token,
      account_id,
      is_connected: true,
      created_at: new Date().toISOString()
    };
    
    await db.collection('social_connections').add(newConnection);
    res.json({ success: true, message: 'Instagram connected successfully' });
  } catch (error) {
    console.error('Error connecting instagram:', error);
    res.status(500).json({ error: 'Failed to connect Instagram' });
  }
});

// ─── GET /api/social/media?type=reels|stories ────────────────────────────────
// Fetches real Instagram reels or stories from the Instagram Graph API
// using the access_token stored in Firestore for this user.
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
      return res.status(403).json({ error: 'Instagram account not connected', notConnected: true });
    }

    const connectionData = connectionsSnapshot.docs[0].data();
    const { access_token, account_id } = connectionData;

    if (!access_token || !account_id) {
      return res.status(403).json({ error: 'Missing Instagram credentials', notConnected: true });
    }

    let mediaItems = [];

    if (type === 'reels') {
      // Fetch reels: media_type VIDEO + is_shared_to_feed true
      const fieldsParam = 'id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink';
      const igUrl = `https://graph.instagram.com/v19.0/${account_id}/media?fields=${fieldsParam}&access_token=${access_token}&limit=20`;

      const igResponse = await fetch(igUrl);
      if (!igResponse.ok) {
        const errText = await igResponse.text();
        console.error('Instagram API error (reels):', errText);
        return res.status(502).json({ error: 'Failed to fetch reels from Instagram' });
      }

      const igData = await igResponse.json();
      const allMedia = igData.data || [];

      // Filter to VIDEO type only (reels)
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
      // Fetch stories from /stories edge
      const fieldsParam = 'id,caption,media_type,media_url,thumbnail_url,timestamp';
      const igUrl = `https://graph.instagram.com/v19.0/${account_id}/stories?fields=${fieldsParam}&access_token=${access_token}&limit=20`;

      const igResponse = await fetch(igUrl);
      if (!igResponse.ok) {
        const errText = await igResponse.text();
        console.error('Instagram API error (stories):', errText);
        return res.status(502).json({ error: 'Failed to fetch stories from Instagram' });
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
    console.error('Error fetching Instagram media:', error);
    res.status(500).json({ error: 'Failed to fetch Instagram media' });
  }
});

module.exports = router;


const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');
const cache = require('../lib/cache');
const logger = require('../lib/logger');

// Automations are cached for 30 seconds per user.
// Cache is busted immediately on any create / toggle / delete so the
// dashboard always reflects the latest state after a write.

// Get all automations for user
router.get('/', async (req, res) => {
  try {
    const db = getFirestore();
    const uid = req.user.uid;
    const cacheKey = `automations_${uid}`;

    // Return cached list if still fresh (30s)
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const automationsRef = db.collection('automations').where('user_uid', '==', uid);
    const snapshot = await automationsRef.get();

    const automations = [];
    snapshot.forEach(doc => {
      automations.push({ id: doc.id, ...doc.data() });
    });

    await cache.set(cacheKey, 30, automations);
    res.json(automations);
  } catch (error) {
    logger.error('Error fetching automations:', { event: 'fetch_automations_failed', error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to fetch automations' });
  }
});

// Create new automation
router.post('/', async (req, res) => {
  try {
    const db = getFirestore();
    const uid = req.user.uid;
    const {
      type,
      name,
      trigger_keyword,
      reply_message,
      dm_reply_enabled,
      dm_reply_message,
      suggest_follow_enabled,
      customize_follow_enabled,
      follow_header,
      follow_subtext,
      follow_button_text,
      done_button_text,
      attach_product_enabled,
      product_name,
      product_desc,
      product_url,
      link2_text,
      link2_url,
      link3_text,
      link3_url
    } = req.body;

    if (!type || !name) {
      return res.status(400).json({ error: 'Missing type or name' });
    }

    const newAuto = {
      user_uid: uid,
      type,
      name,
      status: 'active',
      replies_sent: 0,
      trigger_keyword: trigger_keyword || '',
      reply_message: reply_message || '',
      dm_reply_enabled: !!dm_reply_enabled,
      dm_reply_message: dm_reply_message || '',
      suggest_follow_enabled: !!suggest_follow_enabled,
      customize_follow_enabled: !!customize_follow_enabled,
      follow_header: follow_header || '',
      follow_subtext: follow_subtext || '',
      follow_button_text: follow_button_text || '',
      done_button_text: done_button_text || '',
      attach_product_enabled: !!attach_product_enabled,
      product_name: product_name || '',
      product_desc: product_desc || '',
      product_url: product_url || '',
      link2_text: link2_text || '',
      link2_url: link2_url || '',
      link3_text: link3_text || '',
      link3_url: link3_url || '',
      created_at: new Date().toISOString()
    };

    const docRef = await db.collection('automations').add(newAuto);

    // Bust cache so the new automation shows up immediately
    await cache.del(`automations_${uid}`);

    res.json({ id: docRef.id, ...newAuto });
  } catch (error) {
    logger.error('Error creating automation:', { event: 'create_automation_failed', error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to create automation' });
  }
});

// Toggle automation status
router.put('/:id/toggle', async (req, res) => {
  try {
    const db = getFirestore();
    const uid = req.user.uid;
    const { id } = req.params;

    const docRef = db.collection('automations').doc(id);
    const doc = await docRef.get();

    if (!doc.exists || doc.data().user_uid !== uid) {
      return res.status(404).json({ error: 'Automation not found' });
    }

    const currentStatus = doc.data().status;
    const newStatus = currentStatus === 'active' ? 'paused' : 'active';

    await docRef.update({ status: newStatus });

    // Bust cache so the toggled state reflects immediately
    await cache.del(`automations_${uid}`);

    res.json({ id, status: newStatus });
  } catch (error) {
    logger.error('Error toggling automation:', { event: 'toggle_automation_failed', id, error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to toggle automation' });
  }
});

// Edit existing automation
router.put('/:id', async (req, res) => {
  try {
    const db = getFirestore();
    const uid = req.user.uid;
    const { id } = req.params;

    const docRef = db.collection('automations').doc(id);
    const doc = await docRef.get();

    if (!doc.exists || doc.data().user_uid !== uid) {
      return res.status(404).json({ error: 'Automation not found or unauthorized' });
    }

    const {
      name,
      trigger_keyword,
      reply_message,
      dm_reply_enabled,
      dm_reply_message,
      suggest_follow_enabled,
      customize_follow_enabled,
      follow_header,
      follow_subtext,
      follow_button_text,
      done_button_text,
      attach_product_enabled,
      product_name,
      product_desc,
      product_url,
      link2_text,
      link2_url,
      link3_text,
      link3_url
    } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (trigger_keyword !== undefined) updates.trigger_keyword = trigger_keyword;
    if (reply_message !== undefined) updates.reply_message = reply_message;
    if (dm_reply_enabled !== undefined) updates.dm_reply_enabled = !!dm_reply_enabled;
    if (dm_reply_message !== undefined) updates.dm_reply_message = dm_reply_message;
    if (suggest_follow_enabled !== undefined) updates.suggest_follow_enabled = !!suggest_follow_enabled;
    if (customize_follow_enabled !== undefined) updates.customize_follow_enabled = !!customize_follow_enabled;
    if (follow_header !== undefined) updates.follow_header = follow_header;
    if (follow_subtext !== undefined) updates.follow_subtext = follow_subtext;
    if (follow_button_text !== undefined) updates.follow_button_text = follow_button_text;
    if (done_button_text !== undefined) updates.done_button_text = done_button_text;
    if (attach_product_enabled !== undefined) updates.attach_product_enabled = !!attach_product_enabled;
    if (product_name !== undefined) updates.product_name = product_name;
    if (product_desc !== undefined) updates.product_desc = product_desc;
    if (product_url !== undefined) updates.product_url = product_url;
    if (link2_text !== undefined) updates.link2_text = link2_text;
    if (link2_url !== undefined) updates.link2_url = link2_url;
    if (link3_text !== undefined) updates.link3_text = link3_text;
    if (link3_url !== undefined) updates.link3_url = link3_url;
    updates.updated_at = new Date().toISOString();

    await docRef.update(updates);

    // Bust cache so the updated automation state is reflected immediately
    await cache.del(`automations_${uid}`);

    res.json({ id, ...updates });
  } catch (error) {
    logger.error('Error updating automation:', { event: 'update_automation_failed', id, error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to update automation' });
  }
});

// Delete an automation
router.delete('/:id', async (req, res) => {
  try {
    const db = getFirestore();
    const uid = req.user.uid;
    const { id } = req.params;

    const docRef = db.collection('automations').doc(id);
    const doc = await docRef.get();

    if (!doc.exists || doc.data().user_uid !== uid) {
      return res.status(404).json({ error: 'Automation not found or unauthorized' });
    }

    await docRef.delete();

    // Bust cache so the deleted automation disappears immediately
    await cache.del(`automations_${uid}`);

    res.json({ success: true, message: 'Automation deleted successfully' });
  } catch (error) {
    logger.error('Error deleting automation:', { event: 'delete_automation_failed', id, error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to delete automation' });
  }
});

module.exports = router;


const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');
const cache = require('../lib/cache');

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
    console.error('Error fetching automations:', error);
    res.status(500).json({ error: 'Failed to fetch automations' });
  }
});

// Create new automation
router.post('/', async (req, res) => {
  try {
    const db = getFirestore();
    const uid = req.user.uid;
    const { type, name } = req.body;

    if (!type || !name) {
      return res.status(400).json({ error: 'Missing type or name' });
    }

    const newAuto = {
      user_uid: uid,
      type,
      name,
      status: 'active',
      replies_sent: 0,
      created_at: new Date().toISOString()
    };

    const docRef = await db.collection('automations').add(newAuto);

    // Bust cache so the new automation shows up immediately
    await cache.del(`automations_${uid}`);

    res.json({ id: docRef.id, ...newAuto });
  } catch (error) {
    console.error('Error creating automation:', error);
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
    console.error('Error toggling automation:', error);
    res.status(500).json({ error: 'Failed to toggle automation' });
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
    console.error('Error deleting automation:', error);
    res.status(500).json({ error: 'Failed to delete automation' });
  }
});

module.exports = router;


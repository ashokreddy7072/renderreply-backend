const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');
const cache = require('../lib/cache');

// Referral dashboard cache — 60s TTL per user.
// Falls back to Firestore if Redis is not configured.

// ---------------------------------------------------------------------------
// GET /api/referrals  — Referral dashboard
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const uid = req.user.uid;
    const cacheKey = `referrals_${uid}`;

    // Return cached data if still fresh (60s)
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const db = getFirestore();
    const billingDocRef = db.collection('billing').doc(uid);

    // OPTIMIZATION: Run billing read + referrals query in parallel
    // BEFORE: billing read → wait → referrals query (sequential, 2x latency)
    // AFTER:  both fire simultaneously, result arrives in ~1x latency
    const [billingDoc, referralsSnapshot] = await Promise.all([
      billingDocRef.get(),
      db.collection('referrals').where('referrer_uid', '==', uid).get()
    ]);

    let billingData = {};
    if (!billingDoc.exists) {
      billingData = {
        user_uid: uid,
        currentPlan: 'Free',
        renewalDate: 'Always Active',
        refundStatus: 'Not applicable for Free tier',
        isCancelled: false,
        payments: [],
        invoices: []
      };
      await billingDocRef.set(billingData);
    } else {
      billingData = billingDoc.data();
    }

    // Ensure referral fields are initialised (only writes if something is missing)
    let needsUpdate = false;
    if (!billingData.referralCode) {
      const randomCode = `RR_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
      billingData.referralCode = randomCode;
      billingData.referralLink = `https://renderreply.com/ref?code=${randomCode}`;
      needsUpdate = true;
    }
    if (billingData.walletBalance === undefined) {
      billingData.walletBalance = 0;
      needsUpdate = true;
    }
    if (!billingData.scratchCardState) {
      billingData.scratchCardState = 'locked';
      needsUpdate = true;
    }
    if (!billingData.rewardHistory) {
      billingData.rewardHistory = [];
      needsUpdate = true;
    }

    if (needsUpdate) {
      // Use update() not set() — avoids accidentally overwriting unrelated fields
      await billingDocRef.update({
        referralCode: billingData.referralCode,
        referralLink: billingData.referralLink,
        walletBalance: billingData.walletBalance,
        scratchCardState: billingData.scratchCardState,
        rewardHistory: billingData.rewardHistory
      });
    }

    const referrals = referralsSnapshot.docs.map(doc => doc.data());
    const successfulCount = referrals.filter(r => r.status === 'success').length;

    // Auto-unlock scratch card when milestone reached
    if (successfulCount >= 10 && billingData.scratchCardState === 'locked') {
      billingData.scratchCardState = 'unlocked';
      await billingDocRef.update({ scratchCardState: 'unlocked' });
    }

    const responseData = {
      referralCode: billingData.referralCode,
      referralLink: billingData.referralLink,
      walletBalance: billingData.walletBalance,
      scratchCardState: billingData.scratchCardState,
      rewardHistory: billingData.rewardHistory,
      referralsList: referrals,
      successfulCount
    };

    // Cache for 60 seconds
    await cache.set(cacheKey, 60, responseData);

    res.json(responseData);
  } catch (error) {
    console.error('Error fetching referral stats:', error);
    res.status(500).json({ error: 'Failed to fetch referral dashboard details' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/referrals/claim  — Claim reward from scratch card
// ---------------------------------------------------------------------------
router.post('/claim', async (req, res) => {
  try {
    const uid = req.user.uid;
    const { rewardType } = req.body;

    if (!rewardType || !['cash', 'coupon'].includes(rewardType)) {
      return res.status(400).json({ error: 'Invalid reward selection type' });
    }

    const db = getFirestore();
    const billingDocRef = db.collection('billing').doc(uid);

    // Run billing read + successful referrals count in parallel
    const [billingDoc, referralsSnapshot] = await Promise.all([
      billingDocRef.get(),
      db.collection('referrals')
        .where('referrer_uid', '==', uid)
        .where('status', '==', 'success')
        .get()
    ]);

    if (!billingDoc.exists) {
      return res.status(404).json({ error: 'Billing profile not found' });
    }

    const billingData = billingDoc.data();

    if (referralsSnapshot.size < 10) {
      return res.status(400).json({ error: 'You need 10 successful referral signups to unlock reward scratch cards.' });
    }

    if (billingData.scratchCardState === 'claimed') {
      return res.status(400).json({ error: 'Reward card already scratched and claimed!' });
    }

    let rewardAmountStr = '';
    let rewardValue = 0;
    let couponCode = '';

    if (rewardType === 'coupon') {
      const discountOptions = [10, 15, 20];
      const selectedDiscount = discountOptions[Math.floor(Math.random() * discountOptions.length)];
      couponCode = `REPLY_${selectedDiscount}_${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      rewardAmountStr = `${selectedDiscount}% Discount Coupon`;
      rewardValue = selectedDiscount;
    } else {
      // Budget-controlled wallet cash logic
      const statsDocRef = db.collection('system').doc('stats');
      const statsDoc = await statsDocRef.get();

      let claimCount = 0;
      if (statsDoc.exists) {
        claimCount = statsDoc.data().totalWalletClaims || 0;
      } else {
        await statsDocRef.set({ totalWalletClaims: 0 });
      }

      if (claimCount < 100) {
        const budgetOptions = [50, 60, 70, 80, 85, 90, 95, 100];
        rewardValue = budgetOptions[Math.floor(Math.random() * budgetOptions.length)];
      } else {
        const regularOptions = [5, 10, 15, 20, 25, 30, 40, 45];
        rewardValue = regularOptions[Math.floor(Math.random() * regularOptions.length)];
      }

      rewardAmountStr = `₹${rewardValue} Wallet Cash`;

      await statsDocRef.update({ totalWalletClaims: claimCount + 1 });
    }

    const historyItem = {
      id: `rew_${Date.now()}`,
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
      rewardType,
      rewardValue,
      couponCode,
      rewardText: rewardAmountStr,
      timestamp: new Date().toISOString()
    };

    const currentWallet  = billingData.walletBalance || 0;
    const newWallet      = rewardType === 'cash' ? currentWallet + rewardValue : currentWallet;
    const updatedHistory = [historyItem, ...(billingData.rewardHistory || [])];

    await billingDocRef.update({
      walletBalance: newWallet,
      scratchCardState: 'claimed',
      rewardHistory: updatedHistory,
      claimedReward: historyItem
    });

    // Bust cache so the dashboard reflects the new wallet balance immediately
    await cache.del(`referrals_${uid}`);

    res.json({ success: true, reward: historyItem, newWalletBalance: newWallet });
  } catch (error) {
    console.error('Error claiming referral reward:', error);
    res.status(500).json({ error: 'Failed to process scratch card reward claim' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/referrals/validate  — Register a new signup referral
// ---------------------------------------------------------------------------
router.post('/validate', async (req, res) => {
  try {
    const { referralCode, deviceUuid, referredUsername } = req.body;

    if (!referralCode || !deviceUuid || !referredUsername) {
      return res.status(400).json({ error: 'Missing required validation parameters' });
    }

    const db = getFirestore();

    // Run billing lookup + device anti-spam check in parallel
    const [billingQuery, deviceCheck] = await Promise.all([
      db.collection('billing').where('referralCode', '==', referralCode).get(),
      db.collection('referrals').where('device_uuid', '==', deviceUuid).get()
    ]);

    if (billingQuery.empty) {
      return res.status(404).json({ error: 'Referral code not found' });
    }

    const referrerUid = billingQuery.docs[0].data().user_uid;

    let status  = 'success';
    let message = 'Referral registered successfully!';

    if (!deviceCheck.empty) {
      status  = 'fake_blocked';
      message = 'Sign up completed. (Referral milestone credit skipped - duplicate device detected)';
    }

    const uniqueRefId = `ref_${referrerUid}_${referredUsername.replace(/\s+/g, '_')}`;

    // Check if a pending record already exists for this user-pair
    const pendingQuery = await db.collection('referrals')
      .where('referrer_uid', '==', referrerUid)
      .where('referred_username', '==', referredUsername)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    if (!pendingQuery.empty) {
      await db.collection('referrals').doc(pendingQuery.docs[0].id).update({
        status,
        device_uuid: deviceUuid,
        timestamp: new Date().toISOString()
      });
    } else {
      await db.collection('referrals').doc(uniqueRefId).set({
        id: uniqueRefId,
        referrer_uid: referrerUid,
        referred_username: referredUsername,
        device_uuid: deviceUuid,
        status,
        timestamp: new Date().toISOString()
      });
    }

    // Bust referrer's cache so their count is up-to-date
    await cache.del(`referrals_${referrerUid}`);

    res.json({ success: true, status, message });
  } catch (error) {
    console.error('Error validating referral signup:', error);
    res.status(500).json({ error: 'Failed to validate referral signup' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/referrals/click  — Track a referral link click (pending signup)
// ---------------------------------------------------------------------------
router.post('/click', async (req, res) => {
  try {
    const { referralCode, referredUsername } = req.body;

    if (!referralCode) {
      return res.status(400).json({ error: 'Missing referral code' });
    }

    const db = getFirestore();
    const billingQuery = await db.collection('billing')
      .where('referralCode', '==', referralCode)
      .limit(1)
      .get();

    if (billingQuery.empty) {
      return res.status(404).json({ error: 'Referral code not found' });
    }

    const referrerUid = billingQuery.docs[0].data().user_uid;
    const username    = referredUsername || `Guest_${Math.floor(1000 + Math.random() * 9000)}`;

    // Existence check before writing to avoid duplicate entries
    const existingRef = await db.collection('referrals')
      .where('referrer_uid', '==', referrerUid)
      .where('referred_username', '==', username)
      .limit(1)
      .get();

    if (!existingRef.empty) {
      return res.json({ success: true, message: 'Referral already tracked' });
    }

    const uniqueRefId = `ref_${referrerUid}_${username.replace(/\s+/g, '_')}`;
    await db.collection('referrals').doc(uniqueRefId).set({
      id: uniqueRefId,
      referrer_uid: referrerUid,
      referred_username: username,
      device_uuid: '',
      status: 'pending',
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, referredUsername: username, message: 'Pending referral registered successfully!' });
  } catch (error) {
    console.error('Error tracking referral link click:', error);
    res.status(500).json({ error: 'Failed to record pending referral click' });
  }
});

module.exports = router;

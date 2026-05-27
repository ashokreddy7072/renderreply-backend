const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { getFirestore } = require('firebase-admin/firestore');
const logger = require('../lib/logger');
const cache = require('../lib/cache');

// Ensure Razorpay keys exist in env
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_mock',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'rzp_secret_mock',
});

// ---------------------------------------------------------------------------
// POST /api/billing/create-order — Create Razorpay Order
// ---------------------------------------------------------------------------
router.post('/create-order', async (req, res) => {
  try {
    const uid = req.user.uid;
    const { plan, couponCode } = req.body;

    if (!plan || !['Pro', 'Premium'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    let discountPercent = 0;
    const db = getFirestore();
    
    if (couponCode) {
      const billingDoc = await db.collection('billing').doc(uid).get();
      if (billingDoc.exists) {
        const billingData = billingDoc.data();
        const rewardHistory = billingData.rewardHistory || [];
        const couponItem = rewardHistory.find(
          r => r.rewardType === 'coupon' && r.couponCode === couponCode && !r.isUsed
        );
        
        if (couponItem) {
          discountPercent = couponItem.rewardValue || 15;
        } else {
          return res.status(400).json({ error: 'Invalid or already used coupon code' });
        }
      }
    }

    let amountInInr = plan === 'Premium' ? 7900 : 2900;
    if (discountPercent > 0) {
      amountInInr = Math.round(amountInInr * (1 - discountPercent / 100));
    }
    const amountInPaise = amountInInr * 100;

    const options = {
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${uid}_${Date.now()}`,
      notes: {
        userId: uid,
        planName: plan,
        couponCode: couponCode || '',
        discountPercent: String(discountPercent)
      }
    };

    const order = await razorpay.orders.create(options);

    logger.info(`Razorpay order created for user ${uid}`, { event: 'razorpay_order_created', orderId: order.id, couponCode });

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID || 'rzp_test_mock',
      discountPercent
    });
  } catch (error) {
    logger.error('Error creating Razorpay order:', { event: 'razorpay_order_error', error: error.message });
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/billing/verify-payment — Verify Signature and Update DB
// ---------------------------------------------------------------------------
router.post('/verify-payment', async (req, res) => {
  try {
    const uid = req.user.uid;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan, couponCode } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment verification details' });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET || 'rzp_secret_mock';
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      logger.error('Razorpay signature mismatch (Payment Fraud Attempt)', { event: 'razorpay_signature_mismatch', uid });
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    logger.info(`Razorpay payment verified for ${uid}`, { event: 'razorpay_payment_verified', paymentId: razorpay_payment_id });

    const db = getFirestore();
    const billingDocRef = db.collection('billing').doc(uid);
    const billingDoc = await billingDocRef.get();
    
    let billingData = billingDoc.exists ? billingDoc.data() : { payments: [], invoices: [] };

    let discountPercent = 0;
    let updatedHistory = billingData.rewardHistory || [];

    if (couponCode) {
      updatedHistory = updatedHistory.map(r => {
        if (r.rewardType === 'coupon' && r.couponCode === couponCode) {
          discountPercent = r.rewardValue || 15;
          return { ...r, isUsed: true, usedAt: new Date().toISOString() };
        }
        return r;
      });
    }

    let rawAmount = plan === 'Premium' ? 7900 : 2900;
    if (discountPercent > 0) {
      rawAmount = Math.round(rawAmount * (1 - discountPercent / 100));
    }
    const amountStr = `₹${rawAmount.toLocaleString('en-IN')}.00`;
    const planName = plan === 'Premium' 
      ? (discountPercent > 0 ? `Premium Plan (Annual) • ${discountPercent}% OFF` : 'Premium Plan (Annual)')
      : (discountPercent > 0 ? `Pro Plan (Annual) • ${discountPercent}% OFF` : 'Pro Plan (Annual)');

    const newPayment = {
      id: `pay_${Date.now()}_${uid}`,
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
      amount: amountStr,
      planName,
      status: 'Success',
      transactionId: razorpay_payment_id
    };

    const newInvoice = {
      id: `inv_${Date.now()}_${uid}`,
      invoiceNo: `INV-${new Date().getFullYear()}-0${(billingData.invoices?.length || 0) + 4}`,
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
      amount: amountStr,
      pdfName: `invoice_${razorpay_payment_id}.pdf`
    };

    const updatedPayments = [newPayment, ...(billingData.payments || [])];
    const updatedInvoices = [newInvoice, ...(billingData.invoices || [])];

    const renewalDate = new Date();
    renewalDate.setFullYear(renewalDate.getFullYear() + 1); // Annual subscription
    const renewalStr = renewalDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    await billingDocRef.set({
      currentPlan: plan,
      isCancelled: false,
      renewalDate: renewalStr,
      refundStatus: 'No active refunds in progress',
      payments: updatedPayments,
      invoices: updatedInvoices,
      rewardHistory: updatedHistory
    }, { merge: true });

    await cache.del(`billing_${uid}`);

    res.json({ success: true, message: `Successfully upgraded to ${plan}!` });
  } catch (error) {
    logger.error('Error verifying Razorpay payment:', { event: 'razorpay_verify_error', error: error.message });
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/billing/webhook — Server-to-Server Razorpay Webhook Receiver
// ---------------------------------------------------------------------------
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    
    if (!webhookSecret || !signature) return res.status(400).send('Webhook unconfigured');

    const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(req.body)).digest('hex');
    if (expectedSignature !== signature) {
       return res.status(400).send('Invalid signature');
    }

    const event = req.body.event;
    logger.info(`Received Razorpay webhook event: ${event}`, { event: 'razorpay_webhook_received', type: event });

    // Handle asynchronous payment updates here (e.g. payment.failed, subscription.charged)
    
    res.json({ status: 'ok' });
  } catch (error) {
    logger.error('Error processing Razorpay webhook', { event: 'razorpay_webhook_error', error: error.message });
    res.status(500).send('Webhook Error');
  }
});

module.exports = router;

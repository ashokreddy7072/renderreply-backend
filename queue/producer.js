const { Queue } = require('bullmq');
const Redis = require('ioredis');
const logger = require('../lib/logger');

// Setup Redis connection for BullMQ
const redisConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null, // BullMQ requires maxRetriesPerRequest to be null
});

redisConnection.on('error', (err) => {
  logger.error('BullMQ Redis connection error:', { event: 'bullmq_redis_error', error: err.message });
});

// Create the main Webhook Event Queue
const commentQueue = new Queue('InstagramComments', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000, // 2s, 4s, 8s, 16s, 32s
    },
    removeOnComplete: true, // Keep Redis memory clean
    removeOnFail: 1000,     // Keep last 1000 failed jobs for inspection
  }
});

/**
 * Enqueue an incoming Instagram comment payload
 */
async function enqueueCommentJob(payload) {
  try {
    // Deduplication strategy: Use the unique comment ID from Instagram
    // This prevents processing the same webhook payload twice if Meta retries.
    const jobId = payload.value?.id; 
    
    if (!jobId) {
      logger.warn('Skipping enqueue: Webhook payload missing comment ID.', { event: 'enqueue_skipped_no_id' });
      return null;
    }

    const job = await commentQueue.add('process-comment', payload, {
      jobId: `comment_${jobId}`,
    });
    
    logger.info(`Successfully enqueued job ${job.id}`, { event: 'job_enqueued', jobId: job.id });
    return job;
  } catch (error) {
    logger.error('Failed to enqueue comment job', { event: 'enqueue_error', error: error.message });
    throw error;
  }
}

module.exports = {
  commentQueue,
  enqueueCommentJob,
  redisConnection
};

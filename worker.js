const Queue = require("bull");
const redisClient = require("./services/redis");
const { getVideoDetails, parseDurationToSeconds } = require("./services/youtube");
const { sendToAllTargets } = require("./services/telegram");
const { dbQuery } = require("./services/db");
const cache = require("./services/cache");
const logger = require("./logger");

// Use shared Redis client with proper error handling
const videoQueue = new Queue("video-process", {
  createClient: () => redisClient.duplicate(),
  settings: {
    stalledInterval: 60000,    // Check stalled jobs every 60s (default: 30s)
    maxStalledCount: 2,
    lockDuration: 60000
  }
});

// Handle Redis connection errors gracefully (e.g., ECONNRESET from Upstash free tier)
videoQueue.on('error', (error) => {
  logger.error({
    err: error.message,
    code: error.code,
    syscall: error.syscall
  }, 'Video queue error - connection will retry');
});

const FILTER_KEYWORDS = [
  "#short", "#shorts",
  "short", "shorts",
  "trailer", "clip", "reaction",
  "live", "stream", "streaming",
  "livestream", "live stream"
];
const MIN_SECONDS = 3*60 + 30;
const MAX_SECONDS = 25*60;  // 25 minutes = 1500 seconds

videoQueue.process(2, async (job) => {  // Reduce from 5 to 2 workers
  const payload = job.data;
  const { videoId, channelId, title, published } = payload;
  const startTime = Date.now();

  logger.info({ videoId, channelId, stage: 'start' }, "Worker processing");

  try {
    // IMPORTANT: Check cache FIRST (before DB) to prevent race condition
    // If two workers get same video, cache prevents double processing
    if (cache.get(`proc:${videoId}`)) {
      logger.info({ videoId }, "already processing (cache)");
      return;
    }
    cache.set(`proc:${videoId}`, true, 300);

    // DB dedupe (after cache lock)
    logger.debug({ videoId, stage: 'db-check' }, "Checking DB");
    const existing = await dbQuery("select 1 from videos where video_id = $1", [videoId]);
    if (existing.rowCount > 0) {
      logger.info({ videoId }, "already processed in DB");
      return;
    }

    // title filter
    const lowerTitle = (title || "").toLowerCase();
    if (FILTER_KEYWORDS.some(k => lowerTitle.includes(k))) {
      logger.info({ videoId, title, stage: 'title-filter' }, "filtered by title keyword");
      return;
    }

    logger.debug({ videoId, stage: 'api-call' }, "Fetching YouTube details");
    const details = await getVideoDetails(videoId, false);  // Don't fetch snippet (saves 1 quota)
    if (!details) {
      logger.warn({ videoId }, "no video details from YouTube");
      return;
    }

    // privacy check
    if (details.status && details.status.privacyStatus !== "public") {
      logger.info({ videoId }, "non-public video");
      return;
    }

    const seconds = parseDurationToSeconds(details.contentDetails && details.contentDetails.duration || "PT0S");
    if (seconds <= MIN_SECONDS) {
      logger.info({ videoId, seconds }, "filtered by duration (too short)");
      return;
    }
    if (seconds > MAX_SECONDS) {
      logger.info({ videoId, seconds }, "filtered by duration (too long)");
      return;
    }

    // insert into DB (idempotent via unique constraint)
    const pubAt = published || (details.snippet && details.snippet.publishedAt) || new Date().toISOString();
    await dbQuery("insert into videos (video_id, channel_id, published_at) values ($1,$2,$3) on conflict (video_id) do nothing", [videoId, channelId, pubAt]);

    const accRes = await dbQuery("select a.id, a.name from accounts a join feeds f on f.account_id = a.id where f.channel_id = $1", [channelId]);
    if (accRes.rowCount === 0) {
      logger.info({ channelId }, "no accounts subscribed");
      return;
    }

    // Use title from webhook for notification (more accurate + fresh)
    const displayTitle = title || (details.snippet && details.snippet.title) || "Unknown";

    logger.info({ videoId, stage: 'notification', accounts: accRes.rowCount }, "Sending notifications");

    const url = `https://youtu.be/${videoId}`;

    // Parallelize Telegram sends for better performance
    const sendPromises = accRes.rows.map(acc => {
      const text = `[${escapeHtml(acc.name)}] New video: <b>${escapeHtml(displayTitle)}</b>\n${url}`;

      // Create inline keyboard with protocol handler button
      const reply_markup = {
        inline_keyboard: [[
          {
            text: "📥 Open in Video Cleaner",
            url: `videocleaner://${url}`
          }
        ]]
      };

      return sendToAllTargets(text, { reply_markup }).catch(e => {
        logger.error({ err: e.message, videoId, account: acc.name }, "telegram send failed (worker)");
        throw e; // let Bull retry
      });
    });

    await Promise.all(sendPromises);

    const elapsed = Date.now() - startTime;
    logger.info({ videoId, elapsed, stage: 'complete' }, "Worker completed successfully");
  } catch (err) {
    logger.error({
      videoId,
      channelId,
      err: err.message,
      stack: err.stack,
      stage: 'error'
    }, "Worker processing error");
    throw err;
  } finally {
    cache.del(`proc:${videoId}`);
  }
});

// Daily cleanup queue - removes videos older than 7 days
const cleanupQueue = new Queue("cleanup", {
  createClient: () => redisClient.duplicate()
});

// Handle Redis connection errors for cleanup queue
cleanupQueue.on('error', (error) => {
  logger.error({
    err: error.message,
    code: error.code,
    syscall: error.syscall
  }, 'Cleanup queue error - connection will retry');
});

cleanupQueue.process(async () => {
  logger.info("Running daily cleanup");
  const result = await dbQuery(
    "DELETE FROM videos WHERE published_at < NOW() - INTERVAL '7 days'"
  );
  logger.info({ deletedRows: result.rowCount }, "Cleanup completed");
});

// Schedule daily at 3am
cleanupQueue.add({}, {
  repeat: { cron: '0 3 * * *' },
  removeOnComplete: true
});

// ============================================
// FAILED JOB CLEANUP (Prevent memory leak)
// ============================================
// Clean up failed jobs older than 7 days to prevent Redis memory accumulation
const FAILED_JOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function cleanupFailedJobs() {
  try {
    logger.debug("Checking for old failed jobs");
    const failed = await videoQueue.getFailed();
    let removedCount = 0;

    for (const job of failed) {
      // Check if job has finishedOn timestamp and is old enough
      if (job.finishedOn) {
        const age = Date.now() - job.finishedOn;
        if (age > FAILED_JOB_MAX_AGE_MS) {
          await job.remove();
          removedCount++;
          logger.debug({ jobId: job.id, age: Math.floor(age / 1000 / 60 / 60) + 'h' }, "Removed old failed job");
        }
      }
    }

    if (removedCount > 0) {
      logger.info({ removedCount, totalFailed: failed.length }, "Failed jobs cleanup completed");
    }
  } catch (err) {
    logger.error({ err: err.message }, "Failed job cleanup error");
  }
}

// Run cleanup every hour
setInterval(cleanupFailedJobs, 60 * 60 * 1000);

// Run once on startup (after 30 seconds to let system stabilize)
setTimeout(cleanupFailedJobs, 30000);

logger.info("Worker and cleanup queue initialized");

function escapeHtml(s) { return s ? s.toString().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") : ""; }

// ============================================
// AUTO SUBSCRIPTION RENEWAL (Every 6 hours)
// ============================================
const { subscribeChannel } = require("./services/subscription");

async function renewExpiringSubscriptions() {
  try {
    logger.info("Checking for expiring subscriptions");

    // Find subscriptions expiring within 48 hours
    const expiring = await dbQuery(`
      SELECT channel_id, expires_at, status
      FROM subscriptions
      WHERE expires_at < NOW() + INTERVAL '48 hours'
      AND status IN ('active', 'expiring', 'expired')
      ORDER BY expires_at ASC
    `);

    if (expiring.rowCount === 0) {
      logger.info("No expiring subscriptions found");
      return;
    }

    logger.info({ count: expiring.rowCount }, "Found expiring subscriptions, renewing...");

    let renewed = 0;
    let failed = 0;

    for (const sub of expiring.rows) {
      const result = await subscribeChannel(sub.channel_id);

      if (result.ok) {
        renewed++;
        logger.info({ channelId: sub.channel_id }, "Subscription renewed");
      } else {
        failed++;
        logger.error({ channelId: sub.channel_id, error: result.error }, "Renewal failed");
      }

      // Add delay between renewals to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    logger.info({ renewed, failed, total: expiring.rowCount }, "Subscription renewal completed");

  } catch (err) {
    logger.error({ err: err.message }, "Subscription renewal error");
  }
}

// Run every 6 hours
setInterval(renewExpiringSubscriptions, 6 * 60 * 60 * 1000);

// Run once on startup (after 1 minute to let system stabilize)
setTimeout(renewExpiringSubscriptions, 60000);


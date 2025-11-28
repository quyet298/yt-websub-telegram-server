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

videoQueue.process(2, async (job) => {  // Reduce from 5 to 2 workers
  const payload = job.data;
  const { videoId, channelId, title, published } = payload;
  const startTime = Date.now();

  logger.info({ videoId, channelId, stage: 'start' }, "Worker processing");

  try {
    // DB dedupe
    logger.debug({ videoId, stage: 'db-check' }, "Checking DB");
    const existing = await dbQuery("select 1 from videos where video_id = $1", [videoId]);
    if (existing.rowCount > 0) {
      logger.info({ videoId }, "already processed in DB");
      return;
    }

    // quick in-memory dedupe guard
    if (cache.get(`proc:${videoId}`)) {
      logger.info({ videoId }, "already processing (cache)");
      return;
    }
    cache.set(`proc:${videoId}`, true, 300);

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
      logger.info({ videoId, seconds }, "filtered by duration");
      return;
    }

    // quality check: Full HD only (strict - requires BOTH hd AND maxres)
    const definition = details.contentDetails && details.contentDetails.definition;
    const hasMaxres = details.snippet && details.snippet.thumbnails && details.snippet.thumbnails.maxres;
    if (definition !== "hd" || !hasMaxres) {
      logger.info({ videoId, definition, hasMaxres, stage: 'quality-filter' }, "filtered by quality - Full HD required");
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
    for (const acc of accRes.rows) {
      const text = `[${escapeHtml(acc.name)}] New video: <b>${escapeHtml(displayTitle)}</b>\n${url}`;
      try {
        await sendToAllTargets(text);
      } catch (e) {
        logger.error({ err: e.message, videoId }, "telegram send failed (worker)");
        throw e; // let Bull retry
      }
    }

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

logger.info("Worker and cleanup queue initialized");

function escapeHtml(s) { return s ? s.toString().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") : ""; }


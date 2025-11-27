// --- debug Redis connection (temporary) ---
const IORedis = require('ioredis');
const rawRedisUrl = process.env.REDIS_URL || '';
const masked = rawRedisUrl ? rawRedisUrl.replace(/:(.+)@/, ':*****@') : '(not set)';
console.log('DEBUG REDIS_URL (masked) =>', masked);

// create a small ioredis client only for debug to surface connection events in logs
try {
  const _debugRedis = new IORedis(rawRedisUrl, { connectTimeout: 5000 });
  _debugRedis.on('ready', () => console.log('DEBUG: ioredis ready'));
  _debugRedis.on('connect', () => console.log('DEBUG: ioredis connect event'));
  _debugRedis.on('error', (e) => console.error('DEBUG: ioredis error ->', e && e.message));
  // close after short timeout to avoid leaving extra connection
  setTimeout(() => {
    _debugRedis.quit().catch(()=>{});
    console.log('DEBUG: ioredis debug client closed');
  }, 8000);
} catch (e) {
  console.error('DEBUG: ioredis constructor error ->', e && e.message);
}
// --- end debug block ---

const Queue = require("bull");
const { REDIS_URL } = require("./config");
const { getVideoDetails, parseDurationToSeconds } = require("./services/youtube");
const { sendToAllTargets } = require("./services/telegram");
const { dbQuery } = require("./services/db");
const cache = require("./services/cache");
const logger = require("./logger");

const videoQueue = new Queue("video-process", REDIS_URL);

const FILTER_KEYWORDS = ["#short","shorts","trailer","clip","reaction"];
const MIN_SECONDS = 3*60 + 30;

videoQueue.process(5, async (job) => {
  const payload = job.data;
  const { videoId, channelId, title, published } = payload;
  const start = Date.now();
  logger.info({ videoId, channelId }, "worker processing start");

  try {
    // DB dedupe
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
      logger.info({ videoId, title }, "filtered by title keyword");
      return;
    }

    const details = await getVideoDetails(videoId);
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

    // quality check: YouTube uses 'hd' in definition for HD; check thumbnails.maxres as extra hint
    const definition = details.contentDetails && details.contentDetails.definition;
    const hasMaxres = details.snippet && details.snippet.thumbnails && details.snippet.thumbnails.maxres;
    if (definition !== "hd" && !hasMaxres) {
      logger.info({ videoId }, "filtered by quality");
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

    const url = `https://youtu.be/${videoId}`;
    for (const acc of accRes.rows) {
      const text = `[${escapeHtml(acc.name)}] New video: <b>${escapeHtml(details.snippet.title)}</b>\n${url}`;
      try {
        await sendToAllTargets(text);
      } catch (e) {
        logger.error({ err: e.message, videoId }, "telegram send failed (worker)");
        throw e; // let Bull retry
      }
    }

    const elapsed = Date.now() - start;
    logger.info({ videoId, elapsed }, "worker processed successfully");
  } catch (err) {
    logger.error({ err: err.message, videoId }, "worker processing error");
    throw err;
  } finally {
    cache.del(`proc:${videoId}`);
  }
});

function escapeHtml(s) { return s ? s.toString().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") : ""; }


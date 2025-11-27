const fetch = require("node-fetch");
const cache = require("./cache");
const { YOUTUBE_API_KEY } = require("../config");
const logger = require("../logger");

async function getVideoDetails(videoId, includeSnippet = false) {
  const key = `video:${videoId}:${includeSnippet}`;
  const cached = cache.get(key);
  if (cached) return cached;

  if (!YOUTUBE_API_KEY) {
    logger.warn("YOUTUBE_API_KEY not set; cannot fetch video details");
    return null;
  }

  // Optimize: Only fetch snippet if needed (saves 1 quota)
  const parts = includeSnippet
    ? 'snippet,contentDetails,status'
    : 'contentDetails,status';

  const url = `https://www.googleapis.com/youtube/v3/videos?part=${parts}&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;

  const r = await fetch(url, { timeout: 10000 });
  if (!r.ok) {
    logger.warn({ status: r.status, videoId }, "YouTube API videos.list failed");
    return null;
  }

  const j = await r.json();
  if (!j.items || !j.items.length) return null;

  // Increase cache from 300s (5min) to 3600s (1 hour) to prevent duplicate API calls
  cache.set(key, j.items[0], 3600);
  return j.items[0];
}

function parseDurationToSeconds(duration) {
  if (!duration) return 0;
  const m = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1]||0,10);
  const mm = parseInt(m[2]||0,10);
  const s = parseInt(m[3]||0,10);
  return h*3600 + mm*60 + s;
}

module.exports = { getVideoDetails, parseDurationToSeconds };


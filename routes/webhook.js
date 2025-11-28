const express = require("express");
const router = express.Router();
const xml2js = require("xml2js");
const Queue = require("bull");
const { REDIS_URL } = require("../config");
const logger = require("../logger");

const videoQueue = new Queue("video-process", REDIS_URL, {
  settings: {
    stalledInterval: 60000,    // Check stalled jobs every 60s (default: 30s)
    maxStalledCount: 2,
    lockDuration: 60000
  },
  redis: {
    connectTimeout: 30000,          // 30 seconds
    retryStrategy: (times) => {
      if (times > 50) return null;  // Stop after 50 tries
      return Math.min(times * 100, 3000); // Progressive delay up to 3s
    }
  }
});

router.get("/", (req, res) => {
  const challenge = req.query["hub.challenge"];
  if (challenge) return res.status(200).send(challenge);
  res.sendStatus(200);
});

router.post("/", async (req, res) => {
  const requestId = Math.random().toString(36).substr(2, 9);
  const receivedAt = Date.now();
  const xml = req.body;

  logger.info({ requestId, receivedAt, bodySize: xml?.length }, "Webhook received");

  if (!xml || typeof xml !== "string") return res.sendStatus(400);

  // parse minimal fields
  let parsed;
  try {
    parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
  } catch (err) {
    logger.warn({ err: err.message }, "xml parse failed");
    // ack anyway to avoid repeated retries
    return res.sendStatus(200);
  }

  const feed = parsed.feed || {};
  let entries = feed.entry || [];
  if (!Array.isArray(entries)) entries = [entries];

  for (const entry of entries) {
    if (!entry) continue;
    const videoId = entry["yt:videoId"] || (entry.id && entry.id.toString().split(":").pop());
    const channelId = entry["yt:channelId"] || (entry.author && entry.author.uri && entry.author.uri.toString().split("/").pop());
    const title = entry.title || "";
    const published = entry.published || entry.updated || null;

    if (!videoId || !channelId) continue;

    const jobPayload = {
      videoId,
      channelId,
      title,
      published,
      receivedAt: new Date().toISOString()
    };

    try {
      // use jobId=videoId to dedupe enqueue
      await videoQueue.add(jobPayload, {
        jobId: videoId,
        removeOnComplete: true,
        removeOnFail: false,        // Keep failed jobs for debugging
        attempts: 3,                // Reduce from 5 to 3
        backoff: { type: "exponential", delay: 2000 }  // Increase from 1000 to 2000ms
      });
      const elapsed = Date.now() - receivedAt;
      logger.info({ videoId, channelId, requestId, elapsed }, "Enqueued video job");
    } catch (e) {
      logger.error({ err: e.message, videoId, requestId }, "queue add failed");
    }
  }

  // Ack immediately
  res.sendStatus(200);
});

module.exports = router;


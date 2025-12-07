const fetch = require("node-fetch");
const { HUB_URL, HOST_URL } = require("../config");
const { dbQuery } = require("./db");
const logger = require("../logger");

/**
 * Subscribe to a YouTube channel via WebSub (PubSubHubbub)
 * Includes retry logic with exponential backoff and database persistence
 * @param {string} channelId - YouTube channel ID (UCxxxxxx format)
 * @param {number} retryCount - Current retry attempt (internal use)
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
async function subscribeChannel(channelId, retryCount = 0) {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [1000, 5000, 15000]; // 1s, 5s, 15s

  const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
  const params = new URLSearchParams();
  params.append("hub.mode", "subscribe");
  params.append("hub.topic", topic);
  params.append("hub.callback", `${HOST_URL}/webhook`);
  params.append("hub.verify", "async");

  try {
    const r = await fetch(HUB_URL, {
      method: "POST",
      body: params,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10000
    });

    const responseText = await r.text().catch(() => "");

    if (r.ok) {
      // SUCCESS: Persist to database with expiry (YouTube WebSub typically lasts ~18 days)
      await dbQuery(`
        INSERT INTO subscriptions (channel_id, topic, expires_at, status, last_renewed_at)
        VALUES ($1, $2, NOW() + INTERVAL '18 days', 'active', NOW())
        ON CONFLICT (channel_id) DO UPDATE SET
          status = 'active',
          expires_at = NOW() + INTERVAL '18 days',
          last_renewed_at = NOW(),
          renewal_attempts = 0,
          error_message = NULL
      `, [channelId, topic]);

      logger.info({ channelId, status: r.status }, "YouTube WebSub subscription successful");
      return { ok: true, status: r.status };
    }

    // RETRY on failure
    if (retryCount < MAX_RETRIES) {
      logger.warn({ channelId, status: r.status, retryCount, responseText }, "Subscription failed, retrying...");
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[retryCount]));
      return subscribeChannel(channelId, retryCount + 1);
    }

    // FAILED after all retries - persist failure to database
    await dbQuery(`
      INSERT INTO subscriptions (channel_id, topic, status, error_message, renewal_attempts)
      VALUES ($1, $2, 'failed', $3, $4)
      ON CONFLICT (channel_id) DO UPDATE SET
        status = 'failed',
        error_message = $3,
        renewal_attempts = subscriptions.renewal_attempts + 1
    `, [channelId, topic, `HTTP ${r.status}: ${responseText}`, retryCount + 1]);

    logger.error({ channelId, status: r.status, responseText }, "Subscription failed after retries");
    return { ok: false, status: r.status, error: responseText };

  } catch (err) {
    // NETWORK ERROR - retry
    if (retryCount < MAX_RETRIES) {
      logger.warn({ channelId, err: err.message, retryCount }, "Network error, retrying...");
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[retryCount]));
      return subscribeChannel(channelId, retryCount + 1);
    }

    // FAILED with exception - persist to database
    await dbQuery(`
      INSERT INTO subscriptions (channel_id, topic, status, error_message, renewal_attempts)
      VALUES ($1, $2, 'failed', $3, $4)
      ON CONFLICT (channel_id) DO UPDATE SET
        status = 'failed',
        error_message = $3,
        renewal_attempts = subscriptions.renewal_attempts + 1
    `, [channelId, topic, err.message, retryCount + 1]);

    logger.error({ channelId, err: err.message }, "Subscription error");
    return { ok: false, error: err.message };
  }
}

module.exports = { subscribeChannel };


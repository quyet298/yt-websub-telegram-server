const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const { dbQuery } = require("../services/db");
const { YOUTUBE_API_KEY } = require("../config");
const logger = require("../logger");

// Get all subscriptions
router.get("/subscriptions", async (req, res) => {
  try {
    const subs = await dbQuery(
      "select channel_id, topic, subscribed_at from subscriptions order by subscribed_at desc",
      []
    );
    res.json(subs.rows);
  } catch (err) {
    logger.error({ err: err.message }, "GET /subscriptions error");
    res.status(500).json({ error: "internal error" });
  }
});

// Resolve channel ID from YouTube URL
router.post("/resolve-channel", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: "url required" });
  }

  try {
    // Direct channel ID match
    const directMatch = url.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]+)/);
    if (directMatch && directMatch[1]) {
      return res.json({ channelId: directMatch[1] });
    }

    let channelId = null;

    // Try YouTube API for @handle and /user/
    if (YOUTUBE_API_KEY) {
      // Handle @username format
      const handleMatch = url.match(/youtube\.com\/@([^\/]+)/);
      if (handleMatch && handleMatch[1]) {
        const handle = handleMatch[1];
        const apiUrl =
          'https://www.googleapis.com/youtube/v3/search' +
          '?part=snippet' +
          '&type=channel' +
          '&maxResults=5' +
          '&q=' +
          encodeURIComponent(handle) +
          '&key=' +
          encodeURIComponent(YOUTUBE_API_KEY);

        const rApi = await fetch(apiUrl);
        if (!rApi.ok) {
          logger.error({ status: rApi.status }, 'YouTube API search error');
        } else {
          const j = await rApi.json();
          if (j.items && j.items.length > 0) {
            let best = j.items[0];
            for (const item of j.items) {
              const cu = item.snippet && item.snippet.customUrl;
              if (cu && cu.toLowerCase() === handle.toLowerCase()) {
                best = item;
                break;
              }
            }
            if (best.id && best.id.channelId) {
              channelId = best.id.channelId;
            }
          }
        }
      }

      // Try /user/ format
      if (!channelId) {
        const userMatch = url.match(/youtube\.com\/user\/([^\/\?]+)/);
        if (userMatch && userMatch[1]) {
          const username = userMatch[1];
          const apiUrl =
            'https://www.googleapis.com/youtube/v3/channels' +
            '?part=id' +
            '&forUsername=' +
            encodeURIComponent(username) +
            '&key=' +
            encodeURIComponent(YOUTUBE_API_KEY);

          const rApi = await fetch(apiUrl);
          if (rApi.ok) {
            const j = await rApi.json();
            if (j.items && j.items.length > 0 && j.items[0].id) {
              channelId = j.items[0].id;
            }
          } else {
            logger.error({ status: rApi.status }, 'YouTube API channels error');
          }
        }
      }
    }

    // Fallback: scrape HTML
    if (!channelId) {
      const r = await fetch(url);
      if (!r.ok) {
        return res.status(400).json({ error: 'cannot fetch url', status: r.status });
      }
      const html = await r.text();

      // Try canonical link
      let m = html.match(
        /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[^"]+)"/
      );
      if (m && m[1]) {
        channelId = m[1];
      }

      // Try externalChannelId
      if (!channelId) {
        m = html.match(/"externalChannelId"\s*:\s*"([^"]+)"/);
        if (m && m[1]) {
          channelId = m[1];
        }
      }

      // Try channelId
      if (!channelId) {
        m = html.match(/"channelId"\s*:\s*"([^"]+)"/);
        if (m && m[1]) {
          channelId = m[1];
        }
      }
    }

    if (!channelId || !channelId.startsWith('UC')) {
      return res.status(400).json({ error: 'channelId not found or invalid' });
    }

    res.json({ channelId });
  } catch (err) {
    logger.error({ err: err.message }, 'resolve-channel error');
    res.status(500).json({ error: 'internal error' });
  }
});

// Suggest channels for an account
router.post("/account/:id/suggest-channels", async (req, res) => {
  const accountId = req.params.id;

  if (!YOUTUBE_API_KEY) {
    return res.status(400).json({ error: 'YOUTUBE_API_KEY required' });
  }

  try {
    const accRes = await dbQuery(
      'select id, name from accounts where id = $1',
      [accountId]
    );
    if (accRes.rowCount === 0) {
      return res.status(404).json({ error: 'account not found' });
    }
    const acc = accRes.rows[0];

    const feedsRes = await dbQuery(
      'select distinct channel_id from feeds where account_id = $1',
      [accountId]
    );
    if (feedsRes.rowCount === 0) {
      return res.json({
        basedOn: { accountId: acc.id, accountName: acc.name, baseChannels: [] },
        suggestions: []
      });
    }

    const baseChannels = feedsRes.rows.map((r) => r.channel_id);

    const ignRes = await dbQuery('select channel_id from ignored_channels', []);
    const ignoredSet = new Set(ignRes.rows.map((r) => r.channel_id));
    const currentSet = new Set(baseChannels);

    const counts = {};
    const names = {};

    async function fetchJson(url) {
      const r = await fetch(url);
      if (!r.ok) {
        logger.error({ status: r.status, url }, 'YouTube API error');
        return null;
      }
      return await r.json();
    }

    const maxBase = Math.min(baseChannels.length, 5);
    for (let i = 0; i < maxBase; i++) {
      const chId = baseChannels[i];

      // Get latest videos from channel
      const urlLatest =
        'https://www.googleapis.com/youtube/v3/search' +
        '?part=id' +
        '&channelId=' +
        encodeURIComponent(chId) +
        '&order=date' +
        '&maxResults=3' +
        '&type=video' +
        '&key=' +
        encodeURIComponent(YOUTUBE_API_KEY);

      const latestJson = await fetchJson(urlLatest);
      if (!latestJson || !latestJson.items) continue;

      const videoIds = latestJson.items
        .map((it) => it.id && it.id.videoId)
        .filter(Boolean);

      for (const vId of videoIds) {
        // Get video title
        const urlVideo =
          'https://www.googleapis.com/youtube/v3/videos' +
          '?part=snippet' +
          '&id=' +
          encodeURIComponent(vId) +
          '&key=' +
          encodeURIComponent(YOUTUBE_API_KEY);

        const videoJson = await fetchJson(urlVideo);
        if (
          !videoJson ||
          !videoJson.items ||
          !videoJson.items.length ||
          !videoJson.items[0].snippet
        ) {
          continue;
        }

        const title = videoJson.items[0].snippet.title;
        if (!title) continue;

        // Search by title to find related videos
        const urlSearch =
          'https://www.googleapis.com/youtube/v3/search' +
          '?part=snippet' +
          '&type=video' +
          '&maxResults=10' +
          '&q=' +
          encodeURIComponent(title) +
          '&key=' +
          encodeURIComponent(YOUTUBE_API_KEY);

        const relJson = await fetchJson(urlSearch);
        if (!relJson || !relJson.items) continue;

        for (const item of relJson.items) {
          const s = item.snippet;
          if (!s) continue;
          const rc = s.channelId;
          if (!rc) continue;
          if (!rc.startsWith('UC')) continue;
          if (currentSet.has(rc)) continue;
          if (ignoredSet.has(rc)) continue;

          counts[rc] = (counts[rc] || 0) + 1;
          if (!names[rc]) names[rc] = s.channelTitle || null;
        }
      }
    }

    const suggestions = Object.entries(counts)
      .map(([cid, score]) => ({
        channelId: cid,
        title: names[cid] || null,
        score
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    res.json({
      basedOn: {
        accountId: acc.id,
        accountName: acc.name,
        baseChannels
      },
      suggestions
    });
  } catch (err) {
    logger.error({ err: err.message }, 'POST /account/:id/suggest-channels error');
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;

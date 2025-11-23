// server.js - YouTube WebSub -> Telegram with Neon (PostgreSQL)

const express = require('express');
const cors = require('cors');
const xml2js = require('xml2js');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const HOST_URL = process.env.HOST_URL || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}
if (!HOST_URL) {
  console.error('Missing HOST_URL');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  console.error('Set it to your Neon connection string.');
  process.exit(1);
}

// pg pool (Neon: phải bật ssl)
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function dbQuery(text, params) {
  const res = await pool.query(text, params);
  return res;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  express.text({
    type: ['application/xml', 'application/atom+xml', 'text/xml']
  })
);

// health check
app.get('/', (req, res) => {
  res.send('OK (YouTube WebSub -> Telegram server)');
});

// ---------- TELEGRAM ----------

async function sendTelegram(chat_id, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const r = await axios.post(url, {
      chat_id,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    return r.data;
  } catch (err) {
    console.error(
      'Telegram send error',
      err.response ? err.response.data : err.message
    );
    throw err;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- WEB SUB (SUBSCRIBE) ----------

async function subscribeChannel(channelId) {
  const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
  const params = new URLSearchParams();
  params.append('hub.mode', 'subscribe');
  params.append('hub.topic', topic);
  params.append('hub.callback', `${HOST_URL}/webhook`);
  params.append('hub.verify', 'async');

  try {
    const r = await fetch(HUB_URL, {
      method: 'POST',
      body: params
    });

    const ok = r.ok;
    const status = r.status;
    let text = '';
    try {
      text = await r.text();
    } catch {
      text = '';
    }

    if (ok) {
      await dbQuery(
        `insert into subscriptions (channel_id, topic)
         values ($1, $2)
         on conflict (channel_id) do update
           set topic = excluded.topic,
               subscribed_at = now()`,
        [channelId, topic]
      );
    } else {
      console.error('Hub subscribe failed', status, text);
    }

    return { ok, status, text };
  } catch (err) {
    console.error('SubscribeChannel error', err.message || err);
    return { ok: false, error: err.message };
  }
}

// ---------- API: ACCOUNTS & FEEDS ----------

// POST /account
app.post('/account', async (req, res) => {
  try {
    const { name, telegram_chat_id } = req.body;
    if (!name || !telegram_chat_id) {
      return res
        .status(400)
        .json({ error: 'name and telegram_chat_id required' });
    }

    const result = await dbQuery(
      `insert into accounts (name, telegram_chat_id)
       values ($1, $2)
       returning id, name, telegram_chat_id`,
      [name, telegram_chat_id]
    );

    const row = result.rows[0];
    res.json({
      id: row.id,
      name: row.name,
      telegram_chat_id: row.telegram_chat_id,
      feeds: []
    });
  } catch (err) {
    console.error('POST /account error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /account/:id
app.get('/account/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const acc = await dbQuery(
      'select id, name, telegram_chat_id from accounts where id = $1',
      [id]
    );
    if (acc.rowCount === 0) {
      return res.status(404).json({ error: 'account not found' });
    }
    const feeds = await dbQuery(
      'select channel_id from feeds where account_id = $1 order by id',
      [id]
    );
    res.json({
      id: acc.rows[0].id,
      name: acc.rows[0].name,
      telegram_chat_id: acc.rows[0].telegram_chat_id,
      feeds: feeds.rows.map((r) => r.channel_id)
    });
  } catch (err) {
    console.error('GET /account/:id error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /account/:id/feed
app.post('/account/:id/feed', async (req, res) => {
  const accountId = req.params.id;
  const { channelId } = req.body;
  if (!channelId) {
    return res.status(400).json({ error: 'channelId required' });
  }

  try {
    const acc = await dbQuery(
      'select id, name, telegram_chat_id from accounts where id = $1',
      [accountId]
    );
    if (acc.rowCount === 0) {
      return res.status(404).json({ error: 'account not found' });
    }

    await dbQuery(
      `insert into feeds (account_id, channel_id)
       values ($1, $2)
       on conflict (account_id, channel_id) do nothing`,
      [accountId, channelId]
    );

    const subscribeResult = await subscribeChannel(channelId);

    const feeds = await dbQuery(
      'select channel_id from feeds where account_id = $1 order by id',
      [accountId]
    );

    res.json({
      account: {
        id: acc.rows[0].id,
        name: acc.rows[0].name,
        telegram_chat_id: acc.rows[0].telegram_chat_id,
        feeds: feeds.rows.map((r) => r.channel_id)
      },
      subscribeResult
    });
  } catch (err) {
    console.error('POST /account/:id/feed error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /subscriptions
app.get('/subscriptions', async (req, res) => {
  try {
    const subs = await dbQuery(
      'select channel_id, topic, subscribed_at from subscriptions order by subscribed_at desc',
      []
    );
    res.json(subs.rows);
  } catch (err) {
    console.error('GET /subscriptions error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---------- WEBHOOK ----------

// GET /webhook (hub.challenge)
app.get('/webhook', (req, res) => {
  const challenge = req.query['hub.challenge'];
  if (challenge) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(200);
});

// POST /webhook
app.post('/webhook', async (req, res) => {
  const xml = req.body;
  if (!xml || typeof xml !== 'string') {
    res.sendStatus(400);
    return;
  }

  try {
    const parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: false
    });

    const feed = parsed.feed || {};
    let entries = feed.entry || [];
    if (!Array.isArray(entries)) entries = [entries];

    for (const entry of entries) {
      if (!entry) continue;

      const videoId =
        entry['yt:videoId'] ||
        (entry.id && entry.id.toString().split(':').pop());
      const title = entry.title || '';

      const entryChannelId =
        entry['yt:channelId'] ||
        (entry.author &&
          entry.author.uri &&
          entry.author.uri.toString().split('/').pop());

      if (!videoId || !entryChannelId) {
        console.warn('Missing videoId or channelId in entry');
        continue;
      }

      const accounts = await dbQuery(
        `select a.id, a.name, a.telegram_chat_id
         from accounts a
         join feeds f on f.account_id = a.id
         where f.channel_id = $1`,
        [entryChannelId]
      );

      if (accounts.rowCount === 0) {
        console.log(
          'No accounts for channel',
          entryChannelId,
          'video',
          videoId
        );
        continue;
      }

      const url = `https://youtu.be/${videoId}`;
      for (const acc of accounts.rows) {
        const text = `[${escapeHtml(
          acc.name
        )}] New video: <b>${escapeHtml(title)}</b>\n${url}`;
        try {
          await sendTelegram(acc.telegram_chat_id, text);
        } catch (err) {
          console.error(
            'Failed to send to',
            acc.telegram_chat_id,
            err.message || err
          );
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook parse error', err);
    res.sendStatus(500);
  }
});

// ---------- START ----------

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Webhook endpoint: ${HOST_URL}/webhook`);
});

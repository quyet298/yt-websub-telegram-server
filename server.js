/*
YouTube WebSub -> Telegram server
Single-file Node.js server that:
- Manages accounts (each account has a name, telegram_chat_id, list of channelIds)
- Subscribes to YouTube WebSub hub for channel feeds
- Receives webhook notifications, parses Atom XML, detects new videos
- Sends Telegram messages to account's chat_id with account name + link + video title

Requirements:
- Public HTTPS callback (e.g. https://yourdomain.com/webhook). You can use a VPS with TLS, Cloudflare Tunnel, or any platform that provides HTTPS.
- Environment variables:
  TELEGRAM_BOT_TOKEN - your Telegram bot token
  HOST_URL - public URL where this server is reachable (eg https://example.com)
  PORT - optional (default 3000)

Install:
  npm init -y
  npm install express body-parser node-fetch xml2js lowdb shortid axios

Run:
  node server.js

Notes about Telegram chat_id:
- If user chats with your bot, you can get the chat_id from getUpdates or use a helper bot like @userinfobot.
- Bot must be started by recipient before bot can send messages to them.

Storage:
- Uses lowdb JSON file db.json in working directory. Simple and persistent for small setups.

Endpoints (HTTP JSON):
- POST /account  { name, telegram_chat_id } => create account
- POST /account/:id/feed { channelId } => add channel to account and auto-subscribe to hub
- GET /account/:id => show account
- GET /subscriptions => list subscribed topics
- POST /subscribe (admin) { channelId } => subscribe to hub manually
- Webhook endpoint: GET/POST /webhook (GET used for hub.challenge)

Behavior:
- When webhook POST arrives, parse XML entries and for each video, find which accounts have that channelId and send Telegram message:
  "[AccountName] New video: <title>\nhttps://youtu.be/<videoId>"

You can extend to send to multiple chat_ids, group chats, or use topics.

*/

const express = require('express');
const bodyParser = require('body-parser');
const xml2js = require('xml2js');
const fetch = require('node-fetch');
const { Low, JSONFile } = require('lowdb');
const shortid = require('shortid');
const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const HOST_URL = process.env.HOST_URL || '';
const PORT = process.env.PORT || 3000;
if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN env var');
  process.exit(1);
}
if (!HOST_URL) {
  console.error('Missing HOST_URL env var (public HTTPS URL, e.g. https://example.com)');
  process.exit(1);
}

const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';

// Lowdb setup
const adapter = new JSONFile('db.json');
const db = new Low(adapter);

async function initDB() {
  await db.read();
  db.data = db.data || { accounts: [], subscriptions: {} }; // subscriptions: {channelId: {topic, subscribedAt}}
  await db.write();
}

initDB();

const app = express();
// We need raw body for POST from hub (Atom XML). Use text parser for xml content-type.
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.text({ type: ['application/xml', 'text/*', 'application/atom+xml'] }));

// Helper: subscribe to hub for a channelId
async function subscribeChannel(channelId) {
  const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
  const params = new URLSearchParams();
  params.append('hub.mode', 'subscribe');
  params.append('hub.topic', topic);
  params.append('hub.callback', `${HOST_URL}/webhook`);
  params.append('hub.verify', 'async');
  // optional: set verify_token
  try {
    const r = await fetch(HUB_URL, { method: 'POST', body: params });
    if (r.ok) {
      db.data.subscriptions = db.data.subscriptions || {};
      db.data.subscriptions[channelId] = { topic, subscribedAt: new Date().toISOString() };
      await db.write();
      return { ok: true, status: r.status };
    } else {
      const text = await r.text();
      return { ok: false, status: r.status, text };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Telegram send
async function sendTelegram(chat_id, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const r = await axios.post(url, { chat_id, text, disable_web_page_preview: false, parse_mode: 'HTML' });
    return r.data;
  } catch (err) {
    console.error('Telegram send error', err.response ? err.response.data : err.message);
    throw err;
  }
}

// Create account
app.post('/account', async (req, res) => {
  const { name, telegram_chat_id } = req.body;
  if (!name || !telegram_chat_id) return res.status(400).json({ error: 'name and telegram_chat_id required' });
  const account = { id: shortid.generate(), name, telegram_chat_id, feeds: [] };
  db.data.accounts.push(account);
  await db.write();
  res.json(account);
});

// Add feed to account and auto-subscribe
app.post('/account/:id/feed', async (req, res) => {
  const id = req.params.id;
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  const account = db.data.accounts.find(a => a.id === id);
  if (!account) return res.status(404).json({ error: 'account not found' });
  if (!account.feeds.includes(channelId)) {
    account.feeds.push(channelId);
    await db.write();
  }
  const sub = await subscribeChannel(channelId);
  res.json({ account, subscribeResult: sub });
});

app.get('/account/:id', async (req, res) => {
  const id = req.params.id;
  const account = db.data.accounts.find(a => a.id === id);
  if (!account) return res.status(404).json({ error: 'account not found' });
  res.json(account);
});

app.get('/subscriptions', async (req, res) => {
  res.json(db.data.subscriptions || {});
});

// Manual subscribe endpoint
app.post('/subscribe', async (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  const r = await subscribeChannel(channelId);
  res.json(r);
});

// Webhook endpoint for WebSub hub
app.get('/webhook', (req, res) => {
  // hub.challenge handling
  const challenge = req.query['hub.challenge'];
  if (challenge) {
    // Respond with the challenge token as plain text
    return res.status(200).send(challenge);
  }
  res.sendStatus(200);
});

app.post('/webhook', async (req, res) => {
  const xml = req.body;
  try {
    const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
    // parsed.feed.entry may be an array or single object
    const entries = parsed.feed && parsed.feed.entry ? [].concat(parsed.feed.entry) : [];
    for (const entry of entries) {
      // Extract videoId and channel/topic
      const videoId = (entry['yt:videoId'] || (entry.id && entry.id.split(':').pop()));
      const title = entry.title || '';
      // The feed topic might be present in link rel="self" href=... or in <source><id> etc.
      // Safer: check each subscription topic in DB and see if topic contains channelId
      for (const channelId of Object.keys(db.data.subscriptions || {})) {
        if (!channelId) continue;
        // If entry contains link to video, the feed topic itself not included per-entry; we assume this entry belongs to that channel
        // To be conservative, when a feed contains multiple entries the subscription is for a single channel.
        // We'll notify accounts that have this channelId in their feeds.
        // Check by comparing the <author><uri> or <yt:channelId>
        const entryChannelId = (entry['yt:channelId'] || (entry.author && entry.author.uri && entry.author.uri.split('/').pop()));
        const effectiveChannelId = entryChannelId || channelId;
        if (effectiveChannelId === channelId) {
          // Notify accounts that include this channelId
          const accounts = db.data.accounts.filter(a => (a.feeds || []).includes(channelId));
          for (const acc of accounts) {
            const text = `[${escapeHtml(acc.name)}] New video: <b>${escapeHtml(title)}</b>\nhttps://youtu.be/${videoId}`;
            try {
              await sendTelegram(acc.telegram_chat_id, text);
            } catch (err) {
              console.error('Failed to send telegram to', acc.telegram_chat_id, err.message || err);
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook parse error', err);
    res.sendStatus(500);
  }
});

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Webhook endpoint: ${HOST_URL}/webhook`);
});

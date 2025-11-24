const express = require('express');
const cors = require('cors');
const xml2js = require('xml2js');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const HOST_URL = process.env.HOST_URL || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || ''; 
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
  process.exit(1);
}
if (TELEGRAM_CHAT_IDS.length === 0) {
  console.error('Missing TELEGRAM_CHAT_IDS');
  process.exit(1);
}

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

app.get('/', (req, res) => {
  res.send('OK (YouTube WebSub -> Telegram server)');
});

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

async function sendToAllTargets(text) {
  if (!TELEGRAM_CHAT_IDS.length) return;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      await sendTelegram(chatId, text);
    } catch (e) {
      console.error('Failed to send to', chatId, e.message || e);
    }
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

// accounts: nhóm kênh logic (Quyet, Huong, ...). telegram_chat_id trong DB không dùng, lưu "unused" cho đủ cột.
app.post('/account', async (req, res) => {
  try {
    const { name, telegram_chat_id } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name required' });
    }
    const chatIdStored = telegram_chat_id || 'unused';
    const result = await dbQuery(
      `insert into accounts (name, telegram_chat_id)
       values ($1, $2)
       returning id, name, telegram_chat_id`,
      [name, chatIdStored]
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

app.get('/accounts', async (req, res) => {
  try {
    const accRes = await dbQuery(
      'select id, name, telegram_chat_id from accounts order by name',
      []
    );
    const feedsRes = await dbQuery(
      'select account_id, channel_id from feeds order by id',
      []
    );
    const feedMap = {};
    for (const row of feedsRes.rows) {
      if (!feedMap[row.account_id]) feedMap[row.account_id] = [];
      feedMap[row.account_id].push(row.channel_id);
    }
    const result = accRes.rows.map((a) => ({
      id: a.id,
      name: a.name,
      telegram_chat_id: a.telegram_chat_id,
      feeds: feedMap[a.id] || []
    }));
    res.json(result);
  } catch (err) {
    console.error('GET /accounts error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

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

app.delete('/account/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const r = await dbQuery('delete from accounts where id = $1', [id]);
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'account not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /account/:id error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

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

app.delete('/account/:id/feed', async (req, res) => {
  const accountId = req.params.id;
  const { channelId } = req.body;
  if (!channelId) {
    return res.status(400).json({ error: 'channelId required' });
  }
  try {
    const r = await dbQuery(
      'delete from feeds where account_id = $1 and channel_id = $2',
      [accountId, channelId]
    );
    if (r.rowCount === 0) {
      return res
        .status(404)
        .json({ error: 'feed not found for this account/channel' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /account/:id/feed error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

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

app.post('/resolve-channel', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url required' });
  }

  try {
    // 1) Nếu URL đã là dạng /channel/UC... thì cắt thẳng
    const directMatch = url.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]+)/);
    if (directMatch && directMatch[1]) {
      return res.json({ channelId: directMatch[1] });
    }

    let channelId = null;

    // 2) Nếu có API key, dùng YouTube Data API
    if (YOUTUBE_API_KEY) {
      // 2a) URL dạng @handle
      const handleMatch = url.match(/youtube\.com\/@([^\/]+)/);
      if (handleMatch && handleMatch[1]) {
        const handle = handleMatch[1]; // không có @
        const apiUrl =
          'https://www.googleapis.com/youtube/v3/search'
          + '?part=snippet'
          + '&type=channel'
          + '&maxResults=5'
          + '&q=' + encodeURIComponent(handle)
          + '&key=' + encodeURIComponent(YOUTUBE_API_KEY);

        const rApi = await fetch(apiUrl);
        if (!rApi.ok) {
          console.error('YouTube API search error status:', rApi.status);
        } else {
          const j = await rApi.json();
          if (j.items && j.items.length > 0) {
            // ưu tiên item có customUrl trùng handle (nếu có)
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

      // 2b) URL dạng /user/USERNAME
      if (!channelId) {
        const userMatch = url.match(/youtube\.com\/user\/([^\/\?]+)/);
        if (userMatch && userMatch[1]) {
          const username = userMatch[1];
          const apiUrl =
            'https://www.googleapis.com/youtube/v3/channels'
            + '?part=id'
            + '&forUsername=' + encodeURIComponent(username)
            + '&key=' + encodeURIComponent(YOUTUBE_API_KEY);

          const rApi = await fetch(apiUrl);
          if (rApi.ok) {
            const j = await rApi.json();
            if (j.items && j.items.length > 0 && j.items[0].id) {
              channelId = j.items[0].id;
            }
          } else {
            console.error('YouTube API channels(forUsername) error status:', rApi.status);
          }
        }
      }
    }

    // 3) Nếu vẫn chưa có channelId, fallback HTML (cách cũ, phòng trường hợp API fail)
    if (!channelId) {
      const r = await fetch(url);
      if (!r.ok) {
        return res
          .status(400)
          .json({ error: 'cannot fetch url', status: r.status });
      }
      const html = await r.text();

      let m = html.match(
        /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[^"]+)"/
      );
      if (m && m[1]) {
        channelId = m[1];
      }

      if (!channelId) {
        m = html.match(/"externalChannelId"\s*:\s*"([^"]+)"/);
        if (m && m[1]) {
          channelId = m[1];
        }
      }

      if (!channelId) {
        m = html.match(/"channelId"\s*:\s*"([^"]+)"/);
        if (m && m[1]) {
          channelId = m[1];
        }
      }
    }

    if (!channelId || !channelId.startsWith('UC')) {
      return res
        .status(400)
        .json({ error: 'channelId not found or invalid' });
    }

    res.json({ channelId });
  } catch (err) {
    console.error('resolve-channel error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/webhook', (req, res) => {
  const challenge = req.query['hub.challenge'];
  if (challenge) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(200);
});

app.post('/webhook', async (req, res) => {
  // cleanup videos older than 7 days
  try {
    await dbQuery(
      `delete from videos where published_at < now() - interval '7 days'`,
      []
    );
    console.log('Cleaned old videos (>7 days)');
  } catch (err) {
    console.error('Cleanup error:', err);
  }

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

      const publishedRaw = entry.published || entry.updated;
      let publishedAt = null;
      if (publishedRaw) {
        const d = new Date(publishedRaw);
        if (!isNaN(d.getTime())) {
          publishedAt = d;
        }
      }
      if (!publishedAt) {
        publishedAt = new Date();
      }

      const now = new Date();
      const ageHours =
        (now.getTime() - publishedAt.getTime()) / (1000 * 60 * 60);
      if (ageHours > 20) {
        console.log(
          'Skip old video',
          videoId,
          'age(h)=',
          ageHours.toFixed(2)
        );
        continue;
      }

      const existing = await dbQuery(
        'select 1 from videos where video_id = $1',
        [videoId]
      );
      if (existing.rowCount > 0) {
        console.log('Skip already processed video', videoId);
        continue;
      }

      await dbQuery(
        `insert into videos (video_id, channel_id, published_at)
         values ($1, $2, $3)`,
        [videoId, entryChannelId, publishedAt.toISOString()]
      );

      const accounts = await dbQuery(
        `select a.id, a.name
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
          await sendToAllTargets(text);
        } catch (err) {
          console.error('Failed to send broadcast', err.message || err);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook parse error', err);
    res.sendStatus(500);
  }
});

app.get('/admin', (req, res) => {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="vi">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <title>YouTube WebSub Admin</title>',
    '  <style>',
    '    body {',
    '      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '      background: #f4f4f5;',
    '      margin: 0;',
    '      padding: 20px;',
    '    }',
    '    h1 { margin-top: 0; }',
    '    .card {',
    '      background: #ffffff;',
    '      border-radius: 8px;',
    '      padding: 16px;',
    '      margin-bottom: 16px;',
    '      box-shadow: 0 1px 3px rgba(15,23,42,0.1);',
    '    }',
    '    .row {',
    '      display: flex;',
    '      gap: 8px;',
    '      margin-bottom: 8px;',
    '      flex-wrap: wrap;',
    '    }',
    '    label {',
    '      font-size: 14px;',
    '      color: #374151;',
    '      display: block;',
    '      margin-bottom: 4px;',
    '    }',
    '    input {',
    '      padding: 6px 8px;',
    '      border-radius: 4px;',
    '      border: 1px solid #d1d5db;',
    '      min-width: 0;',
    '    }',
    '    button {',
    '      padding: 6px 10px;',
    '      border-radius: 4px;',
    '      border: none;',
    '      background: #2563eb;',
    '      color: white;',
    '      cursor: pointer;',
    '      font-size: 14px;',
    '    }',
    '    button.danger { background: #dc2626; }',
    '    button.small { padding: 4px 8px; font-size: 12px; }',
    '    button:disabled { opacity: 0.6; cursor: default; }',
    '    .account {',
    '      border-top: 1px solid #e5e7eb;',
    '      padding-top: 12px;',
    '      margin-top: 12px;',
    '    }',
    '    .account-header {',
    '      display: flex;',
    '      justify-content: space-between;',
    '      align-items: center;',
    '      gap: 8px;',
    '    }',
    '    .feeds { margin-top: 8px; font-size: 13px; }',
    '    .feed-item {',
    '      display: flex;',
    '      align-items: center;',
    '      justify-content: space-between;',
    '      gap: 8px;',
    '      padding: 4px 0;',
    '      border-bottom: 1px solid #f3f4f6;',
    '    }',
    '    .pill {',
    '      display: inline-block;',
    '      padding: 2px 6px;',
    '      border-radius: 9999px;',
    '      background: #e5e7eb;',
    '      font-size: 12px;',
    '      color: #111827;',
    '    }',
    '    .status {',
    '      margin-bottom: 12px;',
    '      font-size: 13px;',
    '      min-height: 18px;',
    '    }',
    '    .status.ok { color: #15803d; }',
    '    .status.err { color: #b91c1c; }',
    '    a {',
    '      color: #2563eb;',
    '      text-decoration: none;',
    '      font-size: 12px;',
    '    }',
    '    a:hover { text-decoration: underline; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <h1>YouTube WebSub → Telegram Admin</h1>',
    '  <div id="status" class="status"></div>',
    '  <div class="card">',
    '    <h2>Thêm tài khoản (nhóm kênh)</h2>',
    '    <div class="row">',
    '      <div>',
    '        <label>Tên account</label>',
    '        <input id="newName" placeholder="VD: Quyet, Huong" />',
    '      </div>',
    '      <div style="align-self:flex-end;">',
    '        <button id="btnAddAccount">Thêm tài khoản</button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="card">',
    '    <h2>Danh sách tài khoản & channel</h2>',
    '    <div id="accounts"></div>',
    '  </div>',
    '<script>',
    'const statusEl = document.getElementById("status");',
    'const accountsEl = document.getElementById("accounts");',
    'const btnAddAccount = document.getElementById("btnAddAccount");',
    'const inpName = document.getElementById("newName");',
    'function setStatus(msg, ok = true) {',
    '  statusEl.textContent = msg || "";',
    '  statusEl.className = "status " + (msg ? (ok ? "ok" : "err") : "");',
    '}',
    'async function api(path, options) {',
    '  const res = await fetch(path, {',
    '    headers: { "Content-Type": "application/json" },',
    '    ...options',
    '  });',
    '  if (!res.ok) {',
    '    let msg = res.status + " " + res.statusText;',
    '    try {',
    '      const j = await res.json();',
    '      if (j && j.error) msg = j.error;',
    '    } catch {}',
    '    throw new Error(msg);',
    '  }',
    '  try {',
    '    return await res.json();',
    '  } catch {',
    '    return null;',
    '  }',
    '}',
    'async function loadAccounts() {',
    '  accountsEl.innerHTML = "Đang tải...";',
    '  try {',
    '    const data = await api("/accounts", { method: "GET" });',
    '    if (!data.length) {',
    '      accountsEl.innerHTML = "<i>Chưa có tài khoản nào.</i>";',
    '      return;',
    '    }',
    '    accountsEl.innerHTML = "";',
    '    data.forEach(acc => {',
    '      const accDiv = document.createElement("div");',
    '      accDiv.className = "account";',
    '      let feedsHtml = "";',
    '      if (acc.feeds && acc.feeds.length) {',
    '        acc.feeds.forEach(ch => {',
    '          feedsHtml +=',
    '            "<div class=\\"feed-item\\">" +',
    '              "<div>" +',
    '                "<span class=\\"pill\\">" + ch + "</span> " +',
    '                "<a href=\\"https://www.youtube.com/channel/" + ch + "\\" target=\\"_blank\\">mở kênh</a>" +',
    '              "</div>" +',
    '              "<button class=\\"small danger\\" data-del-feed=\\"" + ch + "\\" data-account=\\"" + acc.id + "\\">Xóa</button>" +',
    '            "</div>";',
    '        });',
    '      } else {',
    '        feedsHtml = "<i>Chưa có channel nào.</i>";',
    '      }',
    '      accDiv.innerHTML =',
    '        "<div class=\\"account-header\\">" +',
    '          "<div>" +',
    '            "<div><b>" + acc.name + "</b> <span class=\\"pill\\">" + acc.id + "</span></div>" +',
    '          "</div>" +',
    '          "<div>" +',
    '            "<button class=\\"small danger\\" data-del-account=\\"" + acc.id + "\\">Xóa tài khoản</button>" +',
    '          "</div>" +',
    '        "</div>" +',
    '        "<div class=\\"feeds\\">" +',
    '          "<div style=\\"margin-bottom:4px;\\"><b>Các channel:</b></div>" +',
    '          "<div class=\\"feed-list\\">" + feedsHtml + "</div>" +',
    '          "<div class=\\"row\\" style=\\"margin-top:8px;\\">" +',
    '            "<div style=\\"flex:1;\\">" +',
    '              "<label>Thêm channel bằng URL</label>" +',
    '              "<input placeholder=\\"https://www.youtube.com/@LegoUnlocked\\" data-url-input=\\"" + acc.id + "\\" style=\\"width:100%;\\" />" +',
    '            "</div>" +',
    '            "<div style=\\"align-self:flex-end;\\">" +',
    '              "<button class=\\"small\\" data-add-feed=\\"" + acc.id + "\\">Thêm</button>" +',
    '            "</div>" +',
    '          "</div>" +',
    '        "</div>";',
    '      accountsEl.appendChild(accDiv);',
    '    });',
    '  } catch (e) {',
    '    accountsEl.innerHTML = "<span style=\\"color:#b91c1c;\\">Lỗi tải accounts: " + e.message + "</span>";',
    '  }',
    '}',
    'btnAddAccount.addEventListener("click", async () => {',
    '  const name = inpName.value.trim();',
    '  if (!name) {',
    '    setStatus("Nhập tên account", false);',
    '    return;',
    '  }',
    '  btnAddAccount.disabled = true;',
    '  try {',
    '    await api("/account", {',
    '      method: "POST",',
    '      body: JSON.stringify({ name })',
    '    });',
    '    setStatus("Đã thêm tài khoản " + name, true);',
    '    inpName.value = "";',
    '    await loadAccounts();',
    '  } catch (e) {',
    '    setStatus("Lỗi thêm tài khoản: " + e.message, false);',
    '  } finally {',
    '    btnAddAccount.disabled = false;',
    '  }',
    '});',
    'accountsEl.addEventListener("click", async (e) => {',
    '  const btn = e.target;',
    '  if (btn.dataset.delAccount) {',
    '    const id = btn.dataset.delAccount;',
    '    if (!confirm("Xóa tài khoản này?")) return;',
    '    btn.disabled = true;',
    '    try {',
    '      await api("/account/" + id, {',
    '        method: "DELETE",',
    '        body: JSON.stringify({})',
    '      });',
    '      setStatus("Đã xóa tài khoản", true);',
    '      await loadAccounts();',
    '    } catch (err) {',
    '      setStatus("Lỗi xóa tài khoản: " + err.message, false);',
    '    } finally {',
    '      btn.disabled = false;',
    '    }',
    '  }',
    '  if (btn.dataset.delFeed) {',
    '    const ch = btn.dataset.delFeed;',
    '    const accId = btn.dataset.account;',
    '    if (!confirm("Xóa channel " + ch + " khỏi tài khoản này?")) return;',
    '    btn.disabled = true;',
    '    try {',
    '      await api("/account/" + accId + "/feed", {',
    '        method: "DELETE",',
    '        body: JSON.stringify({ channelId: ch })',
    '      });',
    '      setStatus("Đã xóa channel " + ch, true);',
    '      await loadAccounts();',
    '    } catch (err) {',
    '      setStatus("Lỗi xóa channel: " + err.message, false);',
    '    } finally {',
    '      btn.disabled = false;',
    '    }',
    '  }',
    '  if (btn.dataset.addFeed) {',
    '    const accId = btn.dataset.addFeed;',
    '    const input = accountsEl.querySelector("input[data-url-input=\\"" + accId + "\\"]");',
    '    if (!input) return;',
    '    const url = input.value.trim();',
    '    if (!url) {',
    '      setStatus("Nhập URL kênh YouTube trước", false);',
    '      return;',
    '    }',
    '    btn.disabled = true;',
    '    try {',
    '      const resolved = await api("/resolve-channel", {',
    '        method: "POST",',
    '        body: JSON.stringify({ url })',
    '      });',
    '      const ch = resolved.channelId;',
    '      await api("/account/" + accId + "/feed", {',
    '        method: "POST",',
    '        body: JSON.stringify({ channelId: ch })',
    '      });',
    '      setStatus("Đã thêm channel " + ch, true);',
    '      input.value = "";',
    '      await loadAccounts();',
    '    } catch (err) {',
    '      setStatus("Lỗi thêm channel: " + err.message, false);',
    '    } finally {',
    '      btn.disabled = false;',
    '    }',
    '  }',
    '});',
    'loadAccounts();',
    '</script>',
    '</body>',
    '</html>'
  ].join('\n');

  res.type('html').send(html);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Webhook endpoint: ${HOST_URL}/webhook`);
});

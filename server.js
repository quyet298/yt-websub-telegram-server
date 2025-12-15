const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const logger = require("./logger");
const { PORT, HOST_URL, ADMIN_TOKEN } = require("./config");
const Queue = require("bull");
const { REDIS_URL } = require("./config");
const { dbQuery } = require("./services/db");
const { sendToAccount } = require("./services/telegram");

const accountsRoutes = require("./routes/accounts");
const webhookRoutes = require("./routes/webhook");
const adminRoutes = require("./routes/admin");
const helperRoutes = require("./routes/helper");

// --------------------------------------------------
// RUN WORKER INSIDE SAME PROCESS (NO EXTRA COST)
// --------------------------------------------------
require("./worker");

// Queue reference for metrics
const videoQueue = new Queue("video-process", REDIS_URL);

const app = express();
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  express.text({
    type: ["application/xml", "application/atom+xml", "text/xml"],
  })
);

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) return next();

  // Check cookie first, then header (NO QUERY PARAMS for security)
  const token = req.cookies.admin_token || req.headers["x-admin-token"];

  if (token === ADMIN_TOKEN) return next();

  // For HTML pages, redirect to login
  if (req.path === '/admin' || req.path === '/metrics') {
    return res.redirect('/login');
  }

  return res.status(401).json({ error: "unauthorized" });
}

app.get("/", (req, res) =>
  res.send("OK (YouTube WebSub -> Telegram refactor + inline worker)")
);

// Login & Logout endpoints
app.get('/login', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
    }
    .login-card {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      width: 100%;
      max-width: 400px;
    }
    h1 {
      margin: 0 0 24px;
      font-size: 28px;
      text-align: center;
      color: #333;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      color: #555;
    }
    input {
      width: 100%;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 6px;
      font-size: 16px;
      box-sizing: border-box;
      transition: border-color 0.3s;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
    }
    button:active {
      transform: translateY(0);
    }
    .error {
      background: #fee;
      color: #c33;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 20px;
      display: none;
    }
    .footer {
      margin-top: 20px;
      text-align: center;
      font-size: 14px;
      color: #777;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>🔐 Admin Login</h1>
    <div id="error" class="error"></div>
    <form id="loginForm">
      <div class="form-group">
        <label for="token">Admin Token</label>
        <input type="password" id="token" name="token" required autofocus>
      </div>
      <button type="submit">Login</button>
    </form>
    <div class="footer">
      YouTube WebSub → Telegram Admin
    </div>
  </div>
  <script>
    const form = document.getElementById('loginForm');
    const errorEl = document.getElementById('error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = document.getElementById('token').value;

      try {
        const res = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });

        const data = await res.json();

        if (data.success) {
          window.location.href = '/admin';
        } else {
          errorEl.textContent = data.error || 'Invalid token';
          errorEl.style.display = 'block';
        }
      } catch (err) {
        errorEl.textContent = 'Login failed: ' + err.message;
        errorEl.style.display = 'block';
      }
    });
  </script>
</body>
</html>
  `;
  res.send(html);
});

app.post('/login', (req, res) => {
  const { token } = req.body;

  if (!ADMIN_TOKEN || token === ADMIN_TOKEN) {
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000  // 30 days
    });
    return res.json({ success: true });
  }

  return res.status(401).json({ success: false, error: 'Invalid token' });
});

app.get('/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.redirect('/login');
});

// Test Video endpoint
app.post('/admin/test-video', adminAuth, async (req, res) => {
  const { url } = req.body;

  // Extract video ID from URL
  let videoId = null;
  const patterns = [
    /youtube\.com\/watch\?v=([^&]+)/,
    /youtu\.be\/([^?]+)/,
    /youtube\.com\/embed\/([^?]+)/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      videoId = match[1];
      break;
    }
  }

  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  try {
    const { getVideoDetails, parseDurationToSeconds } = require('./services/youtube');
    const { sendToAllTargets } = require('./services/telegram');

    // Fetch video details with snippet
    const details = await getVideoDetails(videoId, true);
    if (!details) {
      return res.status(404).json({ error: 'Video not found or API error' });
    }

    // Check filters
    const filterResults = {};

    // Privacy
    const privacyStatus = details.status?.privacyStatus || 'unknown';
    filterResults.privacy = {
      status: privacyStatus,
      pass: privacyStatus === 'public'
    };

    // Duration
    const duration = details.contentDetails?.duration || 'PT0S';
    const seconds = parseDurationToSeconds(duration);
    const MIN_SECONDS = 3*60 + 30;
    filterResults.duration = {
      seconds,
      formatted: formatDuration(seconds),
      pass: seconds > MIN_SECONDS
    };

    // Keywords
    const title = details.snippet?.title || '';
    const FILTER_KEYWORDS = ["short", "shorts", "live", "stream", "streaming", "livestream", "trailer", "clip", "reaction"];
    const matchedKeywords = FILTER_KEYWORDS.filter(k => title.toLowerCase().includes(k));
    filterResults.keywords = {
      title,
      matched: matchedKeywords,
      pass: matchedKeywords.length === 0
    };

    // Overall
    const allPass = filterResults.privacy.pass &&
                    filterResults.duration.pass &&
                    filterResults.keywords.pass;

    // Send to Telegram if requested (force send regardless of filters)
    if (req.body.forceSend) {
      const videoUrl = `https://youtu.be/${videoId}`;
      const text = `[TEST] <b>${escapeHtml(title)}</b>\n${videoUrl}`;

      try {
        await sendToAllTargets(text);
        logger.info({ videoId, title }, 'Test video sent successfully');

        return res.json({
          success: true,
          sent: true,
          message: 'Sent to all Telegram chats',
          filterResults,
          allPass
        });
      } catch (err) {
        logger.error({ err: err.message, videoId }, 'Test video send failed');
        return res.status(500).json({
          success: false,
          sent: false,
          error: err.message,
          filterResults,
          allPass
        });
      }
    }

    // Just return filter results
    return res.json({
      success: true,
      sent: false,
      filterResults,
      allPass,
      videoInfo: {
        title,
        videoId,
        url: `https://youtu.be/${videoId}`
      }
    });

  } catch (err) {
    logger.error({ err: err.message }, 'Test video error');
    return res.status(500).json({ error: err.message });
  }
});

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function escapeHtml(s) {
  return s ? s.toString().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") : "";
}

app.use("/account", adminAuth, accountsRoutes);
app.use("/webhook", webhookRoutes);
app.use("/admin", adminAuth, adminRoutes);  // FIX: Use app.use() for router, not app.get()

app.get("/metrics", adminAuth, async (req, res) => {
  try {
    // Set timeout to 25 seconds (Render has 30s timeout)
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Metrics timeout')), 25000)
    );

    const metricsPromise = Promise.all([
      videoQueue.getJobCounts().catch(err => {
        logger.warn({ err: err.message }, 'Queue stats failed');
        return { waiting: 0, active: 0, completed: 0, failed: 0 };
      }),
      dbQuery('SELECT pg_database_size(current_database()) as size').catch(() => ({ rows: [{ size: 0 }] })),
      dbQuery('SELECT COUNT(*) as count FROM videos').catch(() => ({ rows: [{ count: 0 }] })),
      dbQuery('SELECT COUNT(*) as count FROM accounts').catch(() => ({ rows: [{ count: 0 }] })),
      dbQuery('SELECT COUNT(*) as count FROM feeds').catch(() => ({ rows: [{ count: 0 }] }))
    ]);

    const [stats, dbSize, videoCount, accountCount, feedCount] = await Promise.race([
      metricsPromise,
      timeout
    ]);

    const html = `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>System Metrics</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f5f7fa;
      margin: 0;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      color: #333;
      margin-bottom: 24px;
    }
    .nav {
      margin-bottom: 20px;
    }
    .nav a {
      display: inline-block;
      padding: 8px 16px;
      background: white;
      color: #667eea;
      text-decoration: none;
      border-radius: 6px;
      margin-right: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .nav a:hover {
      background: #667eea;
      color: white;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
    }
    .metric-card {
      background: white;
      padding: 24px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .metric-title {
      font-size: 14px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    .metric-value {
      font-size: 32px;
      font-weight: 700;
      color: #333;
      margin-bottom: 8px;
    }
    .metric-label {
      font-size: 14px;
      color: #999;
    }
    .status-ok {
      color: #10b981;
    }
    .status-warning {
      color: #f59e0b;
    }
    pre {
      background: #1e293b;
      color: #e2e8f0;
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="nav">
      <a href="/admin">← Back to Admin</a>
      <a href="/logout">Logout</a>
    </div>
    <h1>📊 System Metrics</h1>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-title">Queue - Waiting</div>
        <div class="metric-value">${stats.waiting}</div>
        <div class="metric-label">jobs in queue</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Queue - Active</div>
        <div class="metric-value status-ok">${stats.active}</div>
        <div class="metric-label">jobs processing</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Queue - Completed</div>
        <div class="metric-value">${stats.completed}</div>
        <div class="metric-label">total processed</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Queue - Failed</div>
        <div class="metric-value ${stats.failed > 10 ? 'status-warning' : ''}">${stats.failed}</div>
        <div class="metric-label">failed jobs</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Database Size</div>
        <div class="metric-value">${(parseInt(dbSize.rows[0].size) / (1024 * 1024)).toFixed(2)} MB</div>
        <div class="metric-label">of 500 MB limit</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Videos Tracked</div>
        <div class="metric-value">${videoCount.rows[0].count}</div>
        <div class="metric-label">in database</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Accounts</div>
        <div class="metric-value">${accountCount.rows[0].count}</div>
        <div class="metric-label">total accounts</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Channels</div>
        <div class="metric-value">${feedCount.rows[0].count}</div>
        <div class="metric-label">subscribed feeds</div>
      </div>
    </div>
    <div class="metric-card" style="margin-top: 20px;">
      <div class="metric-title">System Info</div>
      <pre>${JSON.stringify({
        uptime: Math.floor(process.uptime()) + ' seconds',
        memory: {
          rss: (process.memoryUsage().rss / 1024 / 1024).toFixed(2) + ' MB',
          heapUsed: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + ' MB'
        },
        nodeVersion: process.version
      }, null, 2)}</pre>
    </div>
  </div>
</body>
</html>
    `;
    res.send(html);
  } catch (err) {
    logger.error({ err: err.message }, "Metrics error");
    // Return user-friendly error page
    return res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Metrics Timeout</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f5f7fa;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .error-card {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      text-align: center;
      max-width: 500px;
    }
    h1 { color: #333; margin-bottom: 16px; }
    p { color: #666; margin-bottom: 24px; }
    a {
      display: inline-block;
      padding: 12px 24px;
      background: #667eea;
      color: white;
      text-decoration: none;
      border-radius: 6px;
      margin: 0 8px;
    }
    a:hover { background: #5568d3; }
  </style>
</head>
<body>
  <div class="error-card">
    <h1>⏱️ Metrics Timeout</h1>
    <p>Database or Redis is waking up from sleep. This is normal for free tier services.</p>
    <p>Please wait 10-15 seconds and try again.</p>
    <div>
      <a href="/metrics">Refresh</a>
      <a href="/admin">Back to Admin</a>
    </div>
  </div>
</body>
</html>
    `);
  }
});
app.use("/", helperRoutes);

// Lightweight ping endpoint (no logging overhead)
app.get('/ping', (req, res) => res.send('pong'));

// Health check with dependency status
const PEAK_HOURS = { start: 6, end: 23 }; // 6am-11pm
app.get('/health', async (req, res) => {
  const hour = new Date().getHours();
  const isPeak = hour >= PEAK_HOURS.start && hour <= PEAK_HOURS.end;

  // Quick health check (no dependencies) for keep-alive pings
  if (req.query.quick === '1') {
    return res.json({
      status: 'ok',
      isPeak,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  }

  // Full health check with dependency status
  const health = {
    status: 'ok',
    isPeak,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dependencies: {}
  };

  // Check Redis (queue backend)
  try {
    await videoQueue.client.ping();
    health.dependencies.redis = { status: 'ok' };
  } catch (err) {
    health.dependencies.redis = { status: 'error', message: err.message };
    health.status = 'degraded';
  }

  // Check Database
  try {
    await dbQuery('SELECT 1');
    health.dependencies.database = { status: 'ok' };
  } catch (err) {
    health.dependencies.database = { status: 'error', message: err.message };
    health.status = 'degraded';
  }

  res.json(health);
});

// Manual subscription renewal endpoint
app.post("/admin/renew-subscription", adminAuth, async (req, res) => {
  const { channelId } = req.body;

  if (!channelId) {
    return res.status(400).json({ error: "channelId required" });
  }

  try {
    const { subscribeChannel } = require('./services/subscription');
    const result = await subscribeChannel(channelId);

    if (result.ok) {
      logger.info({ channelId }, "Manual subscription renewal successful");
      return res.json({
        ok: true,
        message: "Subscription renewed successfully",
        expiresAt: new Date(Date.now() + 18*24*60*60*1000).toISOString()
      });
    } else {
      logger.error({ channelId, error: result.error }, "Manual subscription renewal failed");
      return res.status(500).json({
        ok: false,
        error: result.error || "Subscription failed"
      });
    }
  } catch (err) {
    logger.error({ err: err.message, channelId }, "Renewal error");
    return res.status(500).json({ error: err.message });
  }
});

// Get all subscriptions with status
app.get("/admin/subscriptions", adminAuth, async (req, res) => {
  try {
    const subs = await dbQuery(`
      SELECT
        s.channel_id,
        s.topic,
        s.status,
        s.expires_at,
        s.last_renewed_at,
        s.renewal_attempts,
        s.error_message,
        s.subscribed_at,
        COUNT(DISTINCT f.account_id) as account_count,
        CASE
          WHEN s.expires_at IS NULL THEN 'unknown'
          WHEN s.expires_at < NOW() THEN 'expired'
          WHEN s.expires_at < NOW() + INTERVAL '2 days' THEN 'expiring_soon'
          ELSE 'ok'
        END as health,
        EXTRACT(EPOCH FROM (s.expires_at - NOW())) / 3600 as hours_until_expiry
      FROM subscriptions s
      LEFT JOIN feeds f ON f.channel_id = s.channel_id
      GROUP BY s.channel_id, s.topic, s.status, s.expires_at, s.last_renewed_at,
               s.renewal_attempts, s.error_message, s.subscribed_at
      ORDER BY s.expires_at ASC NULLS LAST
    `);

    const stats = {
      total: subs.rowCount,
      active: subs.rows.filter(s => s.health === 'ok').length,
      expiring_soon: subs.rows.filter(s => s.health === 'expiring_soon').length,
      expired: subs.rows.filter(s => s.health === 'expired').length,
      unknown: subs.rows.filter(s => s.health === 'unknown').length
    };

    return res.json({
      stats,
      subscriptions: subs.rows
    });
  } catch (err) {
    logger.error({ err: err.message }, "Get subscriptions error");
    return res.status(500).json({ error: err.message });
  }
});

// Debug specific video - check all filters
app.post("/admin/debug-video", adminAuth, async (req, res) => {
  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({ error: "videoId required" });
  }

  try {
    const { getVideoDetails, parseDurationToSeconds } = require('./services/youtube');
    const cache = require('./services/cache');

    const checks = {};

    // Check 1: Cache
    checks.cache = {
      processing: !!cache.get(`proc:${videoId}`),
      details: !!cache.get(`video:${videoId}:false`)
    };

    // Check 2: Database
    const dbCheck = await dbQuery("SELECT * FROM videos WHERE video_id = $1", [videoId]);
    checks.database = {
      exists: dbCheck.rowCount > 0,
      row: dbCheck.rows[0] || null
    };

    // Check 3: YouTube API
    const details = await getVideoDetails(videoId, true);
    if (!details) {
      checks.youtubeAPI = { success: false, error: "Video not found or API error" };
      return res.json({ videoId, checks, overallPass: false, blockedBy: "youtube_api" });
    }

    checks.youtubeAPI = {
      success: true,
      privacyStatus: details.status?.privacyStatus || 'unknown',
      duration: details.contentDetails?.duration || 'PT0S',
      title: details.snippet?.title || 'Unknown'
    };

    // Check 4: Title Filter
    const FILTER_KEYWORDS = ["#short", "#shorts", "short", "shorts", "trailer", "clip", "reaction", "live", "stream", "streaming", "livestream"];
    const MIN_SECONDS = 3*60 + 30;
    const lowerTitle = (checks.youtubeAPI.title || "").toLowerCase();
    const matchedKeywords = FILTER_KEYWORDS.filter(k => lowerTitle.includes(k));

    checks.titleFilter = {
      title: checks.youtubeAPI.title,
      matchedKeywords,
      pass: matchedKeywords.length === 0
    };

    // Check 5: Duration
    const seconds = parseDurationToSeconds(checks.youtubeAPI.duration);
    checks.durationFilter = {
      seconds,
      minRequired: MIN_SECONDS,
      formatted: formatDuration(seconds),
      pass: seconds > MIN_SECONDS
    };

    // Check 6: Privacy
    checks.privacyFilter = {
      status: checks.youtubeAPI.privacyStatus,
      pass: checks.youtubeAPI.privacyStatus === 'public'
    };

    // Check 7: Get channel from video
    const channelId = details.snippet?.channelId;
    checks.channelId = channelId;

    // Check 8: Account subscriptions
    if (channelId) {
      const accRes = await dbQuery(`
        SELECT a.id, a.name
        FROM accounts a
        JOIN feeds f ON f.account_id = a.id
        WHERE f.channel_id = $1
      `, [channelId]);

      checks.subscriptions = {
        channelId,
        accounts: accRes.rows,
        count: accRes.rowCount,
        pass: accRes.rowCount > 0
      };

      // Check 9: YouTube WebSub subscription status
      const subRes = await dbQuery("SELECT * FROM subscriptions WHERE channel_id = $1", [channelId]);
      checks.websubStatus = {
        exists: subRes.rowCount > 0,
        status: subRes.rows[0]?.status || null,
        expiresAt: subRes.rows[0]?.expires_at || null,
        lastRenewed: subRes.rows[0]?.last_renewed_at || null
      };
    }

    // Overall pass check
    const overallPass =
      !checks.cache.processing &&
      !checks.database.exists &&
      checks.titleFilter.pass &&
      checks.durationFilter.pass &&
      checks.privacyFilter.pass &&
      checks.subscriptions?.pass;

    // Determine what blocked it
    let blockedBy = null;
    if (checks.cache.processing) blockedBy = "cache_processing";
    else if (checks.database.exists) blockedBy = "database_duplicate";
    else if (!checks.titleFilter.pass) blockedBy = "title_filter";
    else if (!checks.durationFilter.pass) blockedBy = "duration_filter";
    else if (!checks.privacyFilter.pass) blockedBy = "privacy_filter";
    else if (!checks.subscriptions?.pass) blockedBy = "no_subscriptions";
    else if (checks.websubStatus && checks.websubStatus.status !== 'active') blockedBy = "websub_inactive";

    return res.json({
      videoId,
      checks,
      overallPass,
      blockedBy,
      recommendation: blockedBy ? getRecommendation(blockedBy, checks) : "Video should be processed normally"
    });

  } catch (err) {
    logger.error({ err: err.message, videoId }, "Debug video error");
    return res.status(500).json({ error: err.message });
  }
});

function getRecommendation(blockedBy, checks) {
  switch (blockedBy) {
    case "cache_processing":
      return "Video is currently being processed. Wait 5 minutes or clear cache.";
    case "database_duplicate":
      return "Video already processed. Delete from videos table to reprocess.";
    case "title_filter":
      return `Title contains blocked keywords: ${checks.titleFilter.matchedKeywords.join(', ')}`;
    case "duration_filter":
      return `Video is ${checks.durationFilter.seconds}s but requires > ${checks.durationFilter.minRequired}s`;
    case "privacy_filter":
      return `Video privacy is '${checks.privacyFilter.status}' but requires 'public'`;
    case "no_subscriptions":
      return `No accounts subscribed to channel ${checks.channelId}. Add feed to account.`;
    case "websub_inactive":
      return `YouTube WebSub subscription is '${checks.websubStatus.status}'. Renew subscription.`;
    default:
      return "Unknown issue";
  }
}

// ============================================
// BROADCAST - Send message to all users who followed the bot
// ============================================
app.post("/admin/broadcast", adminAuth, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: "Message is required" });
    }

    // Get all accounts with telegram_chat_id
    const accountsResult = await dbQuery(
      `SELECT id, name, telegram_chat_id
       FROM accounts
       WHERE telegram_chat_id IS NOT NULL
         AND telegram_chat_id != ''
         AND telegram_chat_id != 'unused'`
    );

    if (accountsResult.rowCount === 0) {
      return res.status(404).json({
        error: "No accounts with telegram_chat_id found",
        hint: "Update accounts table with valid telegram_chat_id first"
      });
    }

    const results = {
      total: accountsResult.rowCount,
      sent: 0,
      failed: 0,
      errors: []
    };

    // Send to all accounts in parallel
    const sendPromises = accountsResult.rows.map(async (account) => {
      try {
        await sendToAccount(account, message); // No reply_markup for broadcasts
        results.sent++;
        logger.info({ accountId: account.id, chatId: account.telegram_chat_id }, "Broadcast sent");
      } catch (err) {
        results.failed++;
        results.errors.push({
          accountId: account.id,
          chatId: account.telegram_chat_id,
          error: err.message
        });
        logger.error({ accountId: account.id, err: err.message }, "Broadcast failed");
      }
    });

    await Promise.all(sendPromises);

    return res.json({
      success: true,
      message: "Broadcast completed",
      results,
      accounts: accountsResult.rows.map(a => ({
        id: a.id,
        name: a.name,
        telegram_chat_id: a.telegram_chat_id
      }))
    });

  } catch (err) {
    logger.error({ err: err.message }, "Broadcast endpoint error");
    return res.status(500).json({ error: err.message });
  }
});

// ============================================
// DEBUG LOGS - Structured diagnostic export for Claude Code
// ============================================
app.get("/admin/debug-logs", adminAuth, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const sinceTimestamp = Date.now() - (hours * 60 * 60 * 1000);

    // Get in-memory logs
    const recentLogs = logger.getRecentLogs(sinceTimestamp);
    const logStats = logger.getLogStats(sinceTimestamp);

    // Query recent videos and events from database
    const videosResult = await dbQuery(
      `SELECT video_id, channel_id, published_at, created_at
       FROM videos
       WHERE created_at > to_timestamp($1 / 1000.0)
       ORDER BY created_at DESC`,
      [sinceTimestamp]
    );

    const feedsResult = await dbQuery(
      `SELECT a.id, a.name, a.telegram_chat_id, COUNT(f.channel_id) as num_channels
       FROM accounts a
       LEFT JOIN feeds f ON f.account_id = a.id
       GROUP BY a.id, a.name, a.telegram_chat_id`
    );

    const subsResult = await dbQuery(
      `SELECT channel_id, status, expires_at, last_renewed_at, error_message
       FROM subscriptions
       ORDER BY expires_at`
    );

    // Analyze patterns
    const summary = {
      total_videos_processed: videosResult.rowCount,
      time_range_hours: hours,
      accounts: feedsResult.rows,
      subscriptions: subsResult.rows.map(s => ({
        ...s,
        days_remaining: s.expires_at ?
          Math.floor((new Date(s.expires_at) - new Date()) / (1000 * 60 * 60 * 24)) : null
      }))
    };

    const diagnostics = {
      issues: [],
      recommendations: []
    };

    // Check for "no accounts subscribed" scenario
    const accountsWithNoFeeds = feedsResult.rows.filter(a => a.num_channels === 0);
    if (accountsWithNoFeeds.length > 0) {
      diagnostics.issues.push({
        type: "no_accounts_subscribed",
        severity: "CRITICAL",
        message: `${accountsWithNoFeeds.length} account(s) have NO channel subscriptions`,
        affected_accounts: accountsWithNoFeeds,
        fix: "Run: INSERT INTO feeds (account_id, channel_id) SELECT [account_id], channel_id FROM subscriptions WHERE status = 'active'"
      });
    }

    // Check for orphaned subscriptions
    const orphanedSubs = await dbQuery(
      `SELECT s.channel_id, s.status
       FROM subscriptions s
       LEFT JOIN feeds f ON f.channel_id = s.channel_id
       WHERE f.channel_id IS NULL`
    );

    if (orphanedSubs.rowCount > 0) {
      diagnostics.issues.push({
        type: "orphaned_subscriptions",
        severity: "HIGH",
        message: `${orphanedSubs.rowCount} subscriptions have NO feeds mapping`,
        channels: orphanedSubs.rows.map(r => r.channel_id),
        fix: "Channels are subscribed but not linked to any account. Add to feeds table."
      });
    }

    // Check for accounts without telegram_chat_id
    const accountsNoTelegram = feedsResult.rows.filter(a => !a.telegram_chat_id);
    if (accountsNoTelegram.length > 0) {
      diagnostics.issues.push({
        type: "missing_telegram_chat_id",
        severity: "HIGH",
        message: `${accountsNoTelegram.length} account(s) missing telegram_chat_id`,
        affected_accounts: accountsNoTelegram,
        fix: "UPDATE accounts SET telegram_chat_id = '[YOUR_CHAT_ID]' WHERE id = ..."
      });
    }

    // Check for expiring subscriptions
    const expiringSubs = subsResult.rows.filter(s => {
      if (!s.expires_at) return false;
      const daysRemaining = Math.floor((new Date(s.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
      return daysRemaining >= 0 && daysRemaining < 2;
    });

    if (expiringSubs.length > 0) {
      diagnostics.issues.push({
        type: "expiring_subscriptions",
        severity: "MEDIUM",
        message: `${expiringSubs.length} subscription(s) expiring within 48 hours`,
        channels: expiringSubs.map(s => s.channel_id),
        fix: "Auto-renewal should handle this. If not, use /admin/renew-subscription endpoint."
      });
    }

    // Add recommendations
    if (diagnostics.issues.length === 0) {
      diagnostics.recommendations.push("System health looks good! No critical issues detected.");
    } else {
      diagnostics.recommendations.push(
        `Found ${diagnostics.issues.length} issue(s). Fix CRITICAL issues first.`
      );
    }

    res.json({
      generated_at: new Date().toISOString(),
      query_params: { hours },
      summary,
      diagnostics,
      recent_videos: videosResult.rows.slice(0, 50), // Limit to 50 most recent
      log_analysis: {
        total_logs: logStats.total,
        counts_by_message: logStats.by_message,
        sample_logs: recentLogs.slice(0, 100) // Last 100 log entries
      }
    });

  } catch (err) {
    logger.error({ err: err.message }, "debug-logs endpoint error");
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GLOBAL ERROR HANDLERS (Prevent silent crashes)
// ============================================
process.on('unhandledRejection', (reason, promise) => {
  logger.error({
    err: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: String(promise)
  }, 'Unhandled Promise Rejection - Server will continue');
  // Don't exit - let the server continue running
});

process.on('uncaughtException', (error, origin) => {
  logger.error({
    err: error.message,
    stack: error.stack,
    origin
  }, 'Uncaught Exception - Server will continue');
  // Don't exit - let the server continue running
  // Note: In production, uncaught exceptions usually mean the app is in an undefined state
  // But for this free tier server, it's better to stay alive than crash
});

app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
  logger.info(`Webhook endpoint: ${HOST_URL}/webhook`);
});

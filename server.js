const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const logger = require("./logger");
const { PORT, HOST_URL, ADMIN_TOKEN } = require("./config");
const Queue = require("bull");
const { REDIS_URL } = require("./config");
const { dbQuery } = require("./services/db");

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

  // Check cookie first, then header, then query param
  const token = req.cookies.admin_token || req.headers["x-admin-token"] || req.query.admin_token;

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

app.use("/account", adminAuth, accountsRoutes);
app.use("/webhook", webhookRoutes);
app.get("/admin", adminAuth, adminRoutes);
app.get("/metrics", adminAuth, async (req, res) => {
  try {
    const stats = await videoQueue.getJobCounts();

    const dbSize = await dbQuery('SELECT pg_database_size(current_database()) as size');
    const videoCount = await dbQuery('SELECT COUNT(*) as count FROM videos');
    const accountCount = await dbQuery('SELECT COUNT(*) as count FROM accounts');
    const feedCount = await dbQuery('SELECT COUNT(*) as count FROM feeds');

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
    res.status(500).send('Error loading metrics: ' + err.message);
  }
});
app.use("/", helperRoutes);

// Lightweight ping endpoint (no logging overhead)
app.get('/ping', (req, res) => res.send('pong'));

// Health check with peak hour detection
const PEAK_HOURS = { start: 6, end: 23 }; // 6am-11pm
app.get('/health', (req, res) => {
  const hour = new Date().getHours();
  const isPeak = hour >= PEAK_HOURS.start && hour <= PEAK_HOURS.end;
  res.json({
    status: 'ok',
    isPeak,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Metrics endpoint
app.get('/metrics', adminAuth, async (req, res) => {
  try {
    const stats = await videoQueue.getJobCounts();

    const dbSize = await dbQuery('SELECT pg_database_size(current_database()) as size');
    const videoCount = await dbQuery('SELECT COUNT(*) as count FROM videos');
    const accountCount = await dbQuery('SELECT COUNT(*) as count FROM accounts');
    const feedCount = await dbQuery('SELECT COUNT(*) as count FROM feeds');

    res.json({
      queue: {
        waiting: stats.waiting,
        active: stats.active,
        completed: stats.completed,
        failed: stats.failed
      },
      database: {
        sizeBytes: parseInt(dbSize.rows[0].size),
        sizeMB: (parseInt(dbSize.rows[0].size) / (1024 * 1024)).toFixed(2),
        videoCount: parseInt(videoCount.rows[0].count),
        accountCount: parseInt(accountCount.rows[0].count),
        feedCount: parseInt(feedCount.rows[0].count)
      },
      system: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        nodeVersion: process.version
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error({ err: err.message }, "Metrics error");
    res.status(500).json({ error: err.message });
  }
});

// Optional admin endpoint
app.post("/admin/renew-subscriptions", adminAuth, async (req, res) => {
  try {
    return res.json({
      ok: true,
      note: "renew logic not implemented yet",
    });
  } catch (err) {
    logger.error(
      { err: err && err.message },
      "renew-subscriptions error"
    );
    return res.status(500).json({ error: "internal error" });
  }
});

app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
  logger.info(`Webhook endpoint: ${HOST_URL}/webhook`);
});

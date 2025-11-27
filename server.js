const express = require('express');
const cors = require('cors');
const logger = require('./logger');
const { PORT, HOST_URL, ADMIN_TOKEN } = require('./config');

const accountsRoutes = require('./routes/accounts');
const webhookRoutes = require('./routes/webhook');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: ['application/xml','application/atom+xml','text/xml'] }));

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/', (req, res) => res.send('OK (YouTube WebSub -> Telegram refactor)'));

app.use('/account', adminAuth, accountsRoutes);
app.use('/webhook', webhookRoutes);

// simple admin renew-subscriptions placeholder (optional implementation)
app.post('/admin/renew-subscriptions', adminAuth, async (req, res) => {
  // implement renewal logic if desired
  res.json({ ok: true, note: 'implement renew logic in services/subscription' });
});

app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
  logger.info(`Webhook endpoint: ${HOST_URL}/webhook`);
});

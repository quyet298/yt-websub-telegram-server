const express = require("express");
const cors = require("cors");
const logger = require("./logger");
const { PORT, HOST_URL, ADMIN_TOKEN } = require("./config");

const accountsRoutes = require("./routes/accounts");
const webhookRoutes = require("./routes/webhook");

// --------------------------------------------------
// RUN WORKER INSIDE SAME PROCESS (NO EXTRA COST)
// --------------------------------------------------
require("./worker");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  express.text({
    type: ["application/xml", "application/atom+xml", "text/xml"],
  })
);

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = req.headers["x-admin-token"] || req.query.admin_token;
  if (token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: "unauthorized" });
}

app.get("/", (req, res) =>
  res.send("OK (YouTube WebSub -> Telegram refactor + inline worker)")
);

app.use("/account", adminAuth, accountsRoutes);
app.use("/webhook", webhookRoutes);

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

const express = require("express");
const router = express.Router();
const { dbQuery } = require("../services/db");
const { subscribeChannel } = require("../services/subscription");
const logger = require("../logger");

// create account
router.post("/", async (req, res) => {
  try {
    const { name, telegram_chat_id } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const chatIdStored = telegram_chat_id || "unused";
    const r = await dbQuery("insert into accounts (name, telegram_chat_id) values ($1,$2) returning id,name,telegram_chat_id", [name, chatIdStored]);
    res.json({ id: r.rows[0].id, name: r.rows[0].name, telegram_chat_id: r.rows[0].telegram_chat_id, feeds: [] });
  } catch (err) {
    logger.error(err, "POST /account error");
    res.status(500).json({ error: "internal error" });
  }
});

router.get("/", async (req, res) => {
  try {
    const accRes = await dbQuery("select id, name, telegram_chat_id from accounts order by name", []);

    // Get feeds WITH subscription status
    const feedsRes = await dbQuery(`
      SELECT
        f.account_id,
        f.channel_id,
        s.status as sub_status,
        s.expires_at,
        s.last_renewed_at,
        s.error_message,
        CASE
          WHEN s.expires_at IS NULL THEN 'unknown'
          WHEN s.expires_at < NOW() THEN 'expired'
          WHEN s.expires_at < NOW() + INTERVAL '2 days' THEN 'expiring_soon'
          ELSE 'ok'
        END as health,
        EXTRACT(EPOCH FROM (s.expires_at - NOW())) / 3600 as hours_until_expiry
      FROM feeds f
      LEFT JOIN subscriptions s ON s.channel_id = f.channel_id
      ORDER BY f.id
    `, []);

    const feedMap = {};
    for (const row of feedsRes.rows) {
      if (!feedMap[row.account_id]) feedMap[row.account_id] = [];
      feedMap[row.account_id].push({
        channel_id: row.channel_id,
        sub_status: row.sub_status,
        expires_at: row.expires_at,
        last_renewed_at: row.last_renewed_at,
        error_message: row.error_message,
        health: row.health,
        hours_until_expiry: row.hours_until_expiry
      });
    }

    const result = accRes.rows.map((a) => ({
      id: a.id,
      name: a.name,
      telegram_chat_id: a.telegram_chat_id,
      feeds: feedMap[a.id] || []
    }));
    res.json(result);
  } catch (err) {
    logger.error(err, "GET /accounts error");
    res.status(500).json({ error: "internal error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const acc = await dbQuery("select id, name, telegram_chat_id from accounts where id = $1", [id]);
    if (acc.rowCount === 0) return res.status(404).json({ error: "account not found" });
    const feeds = await dbQuery("select channel_id from feeds where account_id = $1 order by id", [id]);
    res.json({ id: acc.rows[0].id, name: acc.rows[0].name, telegram_chat_id: acc.rows[0].telegram_chat_id, feeds: feeds.rows.map(r=>r.channel_id) });
  } catch (err) {
    logger.error(err, "GET /account/:id error");
    res.status(500).json({ error: "internal error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const r = await dbQuery("delete from accounts where id = $1", [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "account not found" });
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, "DELETE /account/:id error");
    res.status(500).json({ error: "internal error" });
  }
});

router.post("/:id/feed", async (req, res) => {
  try {
    const accountId = req.params.id;
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: "channelId required" });
    const acc = await dbQuery("select id, name, telegram_chat_id from accounts where id = $1", [accountId]);
    if (acc.rowCount === 0) return res.status(404).json({ error: "account not found" });
    await dbQuery("insert into feeds (account_id, channel_id) values ($1,$2) on conflict (account_id, channel_id) do nothing", [accountId, channelId]);
    const subscribeResult = await subscribeChannel(channelId);
    const feeds = await dbQuery("select channel_id from feeds where account_id = $1 order by id", [accountId]);
    res.json({ account: { id: acc.rows[0].id, name: acc.rows[0].name, telegram_chat_id: acc.rows[0].telegram_chat_id, feeds: feeds.rows.map(r=>r.channel_id) }, subscribeResult });
  } catch (err) {
    logger.error(err, "POST /account/:id/feed error");
    res.status(500).json({ error: "internal error" });
  }
});

router.delete("/:id/feed", async (req, res) => {
  try {
    const accountId = req.params.id;
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: "channelId required" });
    const r = await dbQuery("delete from feeds where account_id = $1 and channel_id = $2", [accountId, channelId]);
    if (r.rowCount === 0) return res.status(404).json({ error: "feed not found for this account/channel" });
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, "DELETE /account/:id/feed error");
    res.status(500).json({ error: "internal error" });
  }
});

router.post("/ignore-channel", async (req, res) => {
  try {
    const { channelId, reason } = req.body;
    if (!channelId) return res.status(400).json({ error: "channelId required" });
    await dbQuery(`insert into ignored_channels (channel_id, reason) values ($1,$2) on conflict (channel_id) do update set reason = excluded.reason, created_at = now()`, [channelId, reason || null]);
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, "POST /ignore-channel error");
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;


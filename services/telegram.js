const axios = require("axios");
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS } = require("../config");
const logger = require("../logger");

if (!TELEGRAM_BOT_TOKEN) {
  logger.warn("Missing TELEGRAM_BOT_TOKEN - Telegram sending will fail");
}

async function sendTelegram(chat_id, payload) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const r = await axios.post(url, payload, { timeout: 10000 });
    return r.data;
  } catch (err) {
    const status = err.response && err.response.status;
    logger.warn({ status, chat_id }, "telegram send error");
    throw err;
  }
}

async function sendToAllTargets(text, opts = {}) {
  const targets = TELEGRAM_CHAT_IDS && TELEGRAM_CHAT_IDS.length ? TELEGRAM_CHAT_IDS : [];
  if (!targets.length) {
    logger.warn("No TELEGRAM_CHAT_IDS configured");
    throw new Error("No Telegram chat IDs configured");
  }

  const errors = [];
  for (const chatId of targets) {
    try {
      const payload = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: !!opts.disable_web_page_preview
      };

      // Add inline keyboard if provided
      if (opts.reply_markup) {
        payload.reply_markup = opts.reply_markup;
      }

      await sendTelegram(chatId, payload);
    } catch (e) {
      logger.error({ err: e.message, chatId }, "Failed to send to chat");
      errors.push({ chatId, error: e.message });
    }
  }

  // If ALL sends failed, throw error
  if (errors.length === targets.length) {
    throw new Error(`Failed to send to all ${targets.length} chats: ${errors[0].error}`);
  }

  // If SOME sends failed, log warning but don't throw
  if (errors.length > 0) {
    logger.warn({ errors, successCount: targets.length - errors.length }, "Partial send failure");
  }
}

module.exports = { sendTelegram, sendToAllTargets };


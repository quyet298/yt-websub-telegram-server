# yt-websub-telegram-server — refactor with queue & worker

Run locally:
1. copy .env variables (DATABASE_URL, REDIS_URL, TELEGRAM_BOT_TOKEN, HOST_URL, ADMIN_TOKEN, YOUTUBE_API_KEY, TELEGRAM_CHAT_IDS)
2. npm install
3. run migrations (paste sql/migrations.sql into your Postgres)
4. Start web: npm start
5. Start worker: npm run worker

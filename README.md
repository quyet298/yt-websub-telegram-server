# YouTube to Telegram Notification System

Hệ thống tự động theo dõi kênh YouTube và gửi thông báo qua Telegram khi có video mới. Tối ưu cho 100% free tier deployment.

🔗 **Live Demo:** https://yt-websub-telegram-server.onrender.com

## ✨ Tính năng

- ✅ Tự động theo dõi kênh YouTube qua WebSub (PubSubHubbub)
- ✅ Gửi thông báo Telegram tức thì khi có video mới
- ✅ Lọc video chất lượng cao: Full HD, >3m30s, loại bỏ shorts/live/stream
- ✅ Giao diện web quản lý accounts & channels
- ✅ Gợi ý kênh liên quan tự động (AI-powered)
- ✅ Tối ưu hoàn toàn cho free tier (Render + Neon + Upstash)
- ✅ Auto cleanup database, monitoring endpoints

## 🏗️ Kiến trúc

```
YouTube → WebSub Hub → /webhook → Bull Queue (Redis) → Worker → Filters → Telegram
```

**Tech Stack:**
- Node.js + Express
- Bull (job queue) + Redis (Upstash)
- PostgreSQL (Neon)
- YouTube Data API v3
- Telegram Bot API

## 📋 Yêu cầu

### 1. Telegram Bot
1. Chat với [@BotFather](https://t.me/BotFather)
2. Tạo bot mới: `/newbot`
3. Lưu `TELEGRAM_BOT_TOKEN`
4. Lấy chat ID: Chat với bot → [@userinfobot](https://t.me/userinfobot)

### 2. YouTube API Key
1. Truy cập [Google Cloud Console](https://console.cloud.google.com)
2. Tạo project mới
3. Enable "YouTube Data API v3"
4. Credentials → Create API Key
5. Restrict key (chỉ cho YouTube Data API v3)

### 3. Database (Neon - Free)
1. Đăng ký [Neon](https://neon.tech)
2. Tạo database mới
3. Copy connection string

### 4. Redis (Upstash - Free)
1. Đăng ký [Upstash](https://upstash.com)
2. Tạo Redis database
3. Copy `REDIS_URL` (dạng `rediss://...`)

### 5. Hosting (Render - Free)
1. Đăng ký [Render](https://render.com)
2. Fork repo này về GitHub
3. Tạo Web Service từ GitHub repo

## 🚀 Deployment trên Render

### Bước 1: Setup Database Schema

Chạy SQL trong Neon:

```sql
-- File: sql/migrations.sql
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  telegram_chat_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feeds (
  id SERIAL PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(account_id, channel_id)
);

CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
  video_id TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  published_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_videos_channel ON videos(channel_id);
CREATE INDEX idx_videos_published_at ON videos(published_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  channel_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  subscribed_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ignored_channels (
  channel_id TEXT PRIMARY KEY,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Bước 2: Environment Variables

Trong Render Dashboard → Environment:

```bash
DATABASE_URL=postgresql://user:pass@host.neon.tech/dbname?sslmode=require
REDIS_URL=rediss://default:pass@host.upstash.io:6379
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_IDS=12345678,87654321
YOUTUBE_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
HOST_URL=https://your-app.onrender.com
ADMIN_TOKEN=your-secret-admin-password-here
PORT=3000
LOG_LEVEL=info
```

**⚠️ Quan trọng:**
- `HOST_URL` phải là URL chính xác của Render app
- `ADMIN_TOKEN` nên dùng mật khẩu mạnh (để truy cập /admin và /metrics)
- `TELEGRAM_CHAT_IDS` có thể nhiều ID, cách nhau bởi dấu phẩy

### Bước 3: Deploy

```bash
git add .
git commit -m "Deploy to Render"
git push
```

Render sẽ tự động deploy khi detect push.

## 🎮 Sử dụng

### Admin Interface

Truy cập: `https://your-app.onrender.com/admin`

**Chức năng:**
- ➕ Tạo account (nhóm kênh)
- 🔗 Thêm kênh YouTube bằng URL (hỗ trợ @handle, /user/, /channel/)
- 🤖 Gợi ý kênh liên quan tự động
- ❌ Xóa account/channel
- 🚫 Đánh dấu kênh không liên quan

### Monitoring

**Health Check:**
```bash
curl https://your-app.onrender.com/health
```

**Metrics:**
```bash
curl https://your-app.onrender.com/metrics
```

Response:
```json
{
  "queue": {
    "waiting": 0,
    "active": 1,
    "completed": 245,
    "failed": 2
  },
  "database": {
    "sizeBytes": 12345678,
    "sizeMB": "11.77",
    "videoCount": 245,
    "accountCount": 3,
    "feedCount": 15
  },
  "system": {
    "uptime": 86400,
    "memoryUsage": {...},
    "nodeVersion": "v18.x.x"
  }
}
```

## 🔧 Tối ưu Free Tier

Hệ thống đã được tối ưu để chạy hoàn toàn miễn phí:

| Service | Free Tier Limit | Usage sau tối ưu | Status |
|---------|----------------|------------------|--------|
| **Render** | 750 hrs/month | 375 hrs/month (50%) | ✅ 50% dư |
| **Upstash Redis** | 10,000 commands/day | ~4,000/day | ✅ 60% dư |
| **Neon DB** | 191 hrs/month | ~60-90 hrs/month | ✅ 50% dư |
| **YouTube API** | 10,000 quota/day | 2 quota/video | ✅ 5,000 videos/day capacity |

### Các tối ưu đã thực hiện:

1. **Redis:** Giảm workers từ 5 → 2, tăng polling interval
2. **YouTube API:** Chỉ fetch contentDetails + status (không fetch snippet)
3. **Database:** Connection pooling (max: 2), auto close idle connections
4. **Render Sleep:** Chấp nhận occasional cold starts (YouTube WebSub sẽ retry)

### UptimeRobot Setup (Optional)

**Mục đích:** Giảm cold starts trong giờ cao điểm (6am-11pm)

1. Đăng ký [UptimeRobot](https://uptimerobot.com) (free)
2. Tạo HTTP(s) Monitor:
   - **URL:** `https://your-app.onrender.com/ping`
   - **Monitor Type:** Keyword
   - **Keyword:** `pong`
   - **Alert When:** Keyword does NOT exist
   - **Case-sensitive:** OFF
   - **Interval:** 14 minutes
   - **Monitoring Schedule:** Custom (6am-11pm only)

**Kết quả:** Service chỉ sleep ngoài giờ cao điểm, tiết kiệm 50% Render hours.

## 🎯 Video Filtering

Hệ thống lọc video theo các tiêu chí:

### 1. Title Keywords (loại bỏ)
- `short`, `shorts`, `#short`, `#shorts`
- `live`, `stream`, `streaming`, `livestream`
- `trailer`, `clip`, `reaction`

### 2. Duration
- Tối thiểu: **3 phút 30 giây** (210 seconds)

### 3. Quality
- **Full HD only:** Yêu cầu BOTH `hd` definition AND `maxres` thumbnail
- ⚠️ **Lưu ý:** Filter này rất strict. Nếu lọc quá nhiều, sửa `worker.js:78`:
  ```javascript
  // Từ (strict):
  if (definition !== "hd" || !hasMaxres) {

  // Thành (lenient):
  if (definition !== "hd" && !hasMaxres) {
  ```

### 4. Privacy
- Chỉ video **public** (bỏ qua unlisted, private, member-only)

## 📊 Daily Maintenance

**Auto cleanup (3am hàng ngày):**
- Xóa videos cũ hơn 7 ngày
- Giữ database dưới 0.5GB limit

**Manual monitoring (weekly):**
```bash
# Check metrics
curl https://your-app.onrender.com/metrics

# Check Upstash Redis
# → https://console.upstash.com

# Check Neon DB compute
# → https://console.neon.tech

# Check YouTube API quota
# → Google Cloud Console
```

## 🐛 Troubleshooting

### Không nhận được thông báo

1. Kiểm tra `HOST_URL` đúng chưa
2. Kiểm tra webhook subscriptions:
   ```bash
   curl https://your-app.onrender.com/subscriptions
   ```
3. Xem logs trên Render dashboard
4. Kiểm tra video có pass filters không

### Service bị sleep liên tục

- Setup UptimeRobot (xem phần trên)
- Hoặc chấp nhận cold starts (YouTube retry)

### Redis over limit

- Giảm workers xuống 1
- Tăng `stalledInterval` lên 90s

### YouTube API quota exceeded

- Tăng cache TTL lên 2 giờ
- Giảm số channels theo dõi

## 📁 Cấu trúc Project

```
youtube-to-tele/
├── server.js              # Express server + worker inline
├── worker.js              # Bull queue worker + cleanup job
├── config.js              # Environment variables
├── logger.js              # Pino logger
├── package.json           # Dependencies
├── routes/
│   ├── accounts.js        # Account management API
│   ├── webhook.js         # YouTube WebSub handler
│   ├── admin.js           # HTML admin interface
│   └── helper.js          # Channel resolution & suggestions
├── services/
│   ├── youtube.js         # YouTube API client
│   ├── telegram.js        # Telegram Bot API
│   ├── subscription.js    # WebSub subscription
│   ├── db.js              # PostgreSQL client
│   └── cache.js           # In-memory cache
└── sql/
    └── migrations.sql     # Database schema
```

## 🔒 Security

- ✅ Admin endpoints protected by `ADMIN_TOKEN`
- ✅ Database SSL enabled
- ✅ No secrets in code
- ✅ SQL injection prevention (parameterized queries)
- ✅ XSS prevention (HTML escaping)

## 📝 License

MIT

---

**🚀 Built with:** Express • Bull • PostgreSQL • Redis • Telegram Bot API • YouTube Data API

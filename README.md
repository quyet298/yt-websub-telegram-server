# YouTube WebSub → Telegram Notification Server

Dự án này là một Node.js server dùng để:
- Theo dõi các kênh YouTube bằng WebSub (PubSubHubbub)
- Tự động nhận thông báo khi có video mới
- Gửi tin nhắn Telegram đến từng tài khoản, kèm tên tài khoản + link video

## Tính năng
- Quản lý nhiều tài khoản (account)
- Mỗi account chứa danh sách kênh yêu thích
- Tự động subscribe kênh qua PubSubHubbub
- Nhận webhook từ YouTube và gửi tin nhắn Telegram
- API REST đơn giản để thêm account và feed

## Công nghệ
- Node.js + Express
- WebSub (PubSubHubbub)
- Telegram Bot API
- JSON storage / DB ngoài (tùy bạn cấu hình)

## Cách triển khai (Render)
1. Tạo repository GitHub (Private được hỗ trợ)
2. Upload file:
   - server.js
   - package.json
   - README.md
   - .gitignore
3. Tạo Web Service trên Render
4. Thêm Environment Variables:
   - TELEGRAM_BOT_TOKEN
   - HOST_URL (URL public của service trên Render)
5. Deploy

## API sử dụng
### Tạo account
POST `/account`
```json
{ "name": "Quyết iu", "telegram_chat_id": "quyetiu_bot" }

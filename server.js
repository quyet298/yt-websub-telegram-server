// server.js - bản test đơn giản

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// để đọc JSON body
app.use(express.json());

// test: GET / => trả chữ OK
app.get('/', (req, res) => {
  res.send('OK');
});

// test: POST /account => echo lại dữ liệu
app.post('/account', (req, res) => {
  const { name, telegram_chat_id } = req.body;

  if (!name || !telegram_chat_id) {
    return res.status(400).json({ error: 'name and telegram_chat_id required' });
  }

  // tạm thời trả id giả để test
  res.json({
    id: 'test-id-123',
    name,
    telegram_chat_id,
    feeds: []
  });
});

// chạy server
app.listen(PORT, () => {
  console.log(`Test server listening on port ${PORT}`);
});

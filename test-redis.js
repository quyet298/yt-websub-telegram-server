// test-redis.js
const Redis = require('ioredis');
const url = process.argv[2];
if (!url) return console.error('usage: node test-redis.js <REDIS_URL>');
const r = new Redis(url);
(async ()=> {
  try {
    const pong = await r.ping();
    console.log('PING ->', pong);
    const info = await r.info();
    console.log('INFO first line:', info.split('\n')[0]);
    await r.quit();
  } catch (e) {
    console.error('CONNECT ERROR', e.message);
    process.exit(1);
  }
})();

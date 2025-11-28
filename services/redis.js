const Redis = require("ioredis");
const { REDIS_URL } = require("../config");
const logger = require("../logger");

// Create shared Redis client with proper error handling
// This prevents unhandled ECONNRESET errors that crash the app
const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,     // Disable per-request limit (let retryStrategy control)
  enableReadyCheck: false,         // Disable ready check to avoid extra commands
  connectTimeout: 30000,           // 30 seconds to connect
  retryStrategy: (times) => {
    // Retry indefinitely with progressive delay
    const delay = Math.min(times * 100, 3000); // 100ms → 3s max
    logger.debug({ times, delay }, "Redis retry attempt");
    return delay;
  },
  reconnectOnError: (err) => {
    // Reconnect on specific errors
    const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
    if (targetErrors.some(e => err.message.includes(e))) {
      logger.warn({ err: err.message }, "Redis reconnecting on error");
      return true; // Reconnect
    }
    return false;
  }
});

// Global error handlers to prevent crashes
redisClient.on('error', (err) => {
  logger.error({
    err: err.message,
    code: err.code,
    syscall: err.syscall
  }, 'Redis client error - will retry connection');
  // Do NOT throw - just log and let retry strategy handle it
});

redisClient.on('connect', () => {
  logger.info('Redis client connecting');
});

redisClient.on('ready', () => {
  logger.info('Redis client ready');
});

redisClient.on('reconnecting', () => {
  logger.warn('Redis client reconnecting after connection loss');
});

redisClient.on('close', () => {
  logger.warn('Redis client connection closed');
});

// Handle process termination
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, closing Redis client');
  redisClient.quit();
});

module.exports = redisClient;

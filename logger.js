const pino = require("pino");
const { LOG_LEVEL } = require("./config");

// Ring buffer for recent logs (keep last 1000 entries)
const recentLogs = [];
const MAX_LOG_BUFFER = 1000;

const logger = pino({
  level: LOG_LEVEL,
  hooks: {
    logMethod(inputArgs, method) {
      // Store structured logs in memory for debug endpoint
      if (inputArgs[0] && typeof inputArgs[0] === 'object') {
        const logEntry = {
          timestamp: Date.now(),
          level: this.level,
          ...inputArgs[0],
          message: inputArgs[1]
        };

        recentLogs.push(logEntry);

        // Keep only last MAX_LOG_BUFFER entries (FIFO)
        if (recentLogs.length > MAX_LOG_BUFFER) {
          recentLogs.shift();
        }
      }
      return method.apply(this, inputArgs);
    }
  }
});

// Export helper function for debug endpoint
logger.getRecentLogs = (sinceTimestamp) => {
  if (!sinceTimestamp) return recentLogs;
  return recentLogs.filter(log => log.timestamp >= sinceTimestamp);
};

// Get log stats by message pattern
logger.getLogStats = (sinceTimestamp) => {
  const logs = logger.getRecentLogs(sinceTimestamp);
  const stats = {
    total: logs.length,
    by_message: {}
  };

  logs.forEach(log => {
    const msg = log.message || log.msg || 'unknown';
    stats.by_message[msg] = (stats.by_message[msg] || 0) + 1;
  });

  return stats;
};

module.exports = logger;


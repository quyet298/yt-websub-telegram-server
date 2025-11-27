const { Pool } = require("pg");
const { DATABASE_URL } = require("../config");
const logger = require("../logger");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,                      // Reduce from default 10 to save DB compute
  idleTimeoutMillis: 30000,    // Close idle connections after 30s
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: true        // Allow pool to fully close when idle
});

async function dbQuery(text, params) {
  logger.debug({ text, params: params && params.slice(0,3) }, "dbQuery");
  return pool.query(text, params);
}

module.exports = { pool, dbQuery };


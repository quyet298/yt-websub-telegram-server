#!/usr/bin/env node
/**
 * Database Migration Script
 * Run with: node scripts/migrate.js
 * Or via npm: npm run migrate
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ ERROR: DATABASE_URL environment variable not set');
  console.error('Please set DATABASE_URL before running migrations');
  process.exit(1);
}

async function runMigration() {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    console.log('🔌 Connecting to database...');
    const client = await pool.connect();

    console.log('📄 Reading migration file...');
    const migrationSQL = fs.readFileSync(
      path.join(__dirname, '..', 'sql', 'add-subscription-tracking.sql'),
      'utf8'
    );

    console.log('🚀 Running migration...');
    await client.query(migrationSQL);

    console.log('✅ Migration completed successfully!');
    console.log('\nVerifying new columns...');

    const result = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'subscriptions'
      AND column_name IN ('expires_at', 'last_renewed_at', 'status', 'error_message', 'renewal_attempts')
      ORDER BY column_name
    `);

    console.log('\n📊 New columns added:');
    result.rows.forEach(row => {
      console.log(`  ✓ ${row.column_name} (${row.data_type})`);
    });

    // Check existing subscriptions
    const subCount = await client.query('SELECT COUNT(*) FROM subscriptions');
    console.log(`\n📈 Total subscriptions: ${subCount.rows[0].count}`);

    const activeCount = await client.query("SELECT COUNT(*) FROM subscriptions WHERE status = 'active'");
    console.log(`   Active: ${activeCount.rows[0].count}`);

    const expiredCount = await client.query("SELECT COUNT(*) FROM subscriptions WHERE expires_at < NOW()");
    console.log(`   Expired: ${expiredCount.rows[0].count}`);

    client.release();
    await pool.end();

    console.log('\n🎉 Done! Your application should now work correctly.');

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error(err.stack);
    await pool.end();
    process.exit(1);
  }
}

runMigration();

/**
 * Database Migration Runner
 *
 * Runs on every deploy via `npm run build`.
 *
 * How it works:
 * 1. Creates core tables (users, _migrations) - always runs, idempotent
 * 2. Reads migrations from migrations/ folder
 * 3. Runs new migrations in order (tracked in _migrations table)
 *
 * To create a new migration:
 *   Create a file in migrations/ with format: {timestamp}_{name}.js
 *   Example: migrations/1704067200000_add_products_table.js
 *
 * Migration file format:
 *   module.exports = {
 *     name: 'add_products_table',
 *     up: async (client) => {
 *       await client.query(`CREATE TABLE products (...)`);
 *     }
 *   };
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const MIGRATION_RETRY_DELAYS = [1000, 3000, 7000, 15000];

function isTransientDatabaseError(err) {
  const message = String(err && err.message || '').toLowerCase();
  const transientMessages = [
    'rate limit',
    'too many connections',
    'connection terminated',
    'connection reset',
    'econnreset',
    'etimedout',
    'timeout',
    'server closed the connection unexpectedly',
    'the database system is starting up'
  ];
  const transientCodes = new Set(['08000', '08001', '08003', '08004', '08006', '40001', '40P01', '53300', '57P01']);
  return transientCodes.has(err && err.code) || transientMessages.some(text => message.includes(text));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function migrateOnce() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  console.log('Running migrations...');

  let client;
  try {
    client = await pool.connect();
    // 1. Create migration tracking table (always first)
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Core tables (idempotent - safe to run every time)
    await runCoreMigrations(client);

    // 3. Run migrations from migrations/ folder
    await runFolderMigrations(client);

    console.log('Migrations complete.');
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

async function migrate() {
  for (let attempt = 0; attempt <= MIGRATION_RETRY_DELAYS.length; attempt += 1) {
    try {
      return await migrateOnce();
    } catch (err) {
      const delay = MIGRATION_RETRY_DELAYS[attempt];
      if (!delay || !isTransientDatabaseError(err)) throw err;
      console.warn(`[Migrations] transient database error; retrying in ${delay / 1000}s`);
      await wait(delay);
    }
  }
}

/**
 * Core tables that every app needs.
 * These use CREATE IF NOT EXISTS so they're safe to run repeatedly.
 */
async function runCoreMigrations(client) {
  // Users table with subscription support
  // Used by Polsia for syncing end-user subscription status
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      password_hash VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      -- Subscription fields (synced by Polsia when customer subscribes)
      stripe_subscription_id VARCHAR(255),
      subscription_status VARCHAR(50),
      subscription_plan VARCHAR(255),
      subscription_expires_at TIMESTAMPTZ,
      subscription_updated_at TIMESTAMPTZ
    )
  `);

  // Unique constraint on email (required for UPSERT)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email))
  `);

  // Index for subscription lookups
  await client.query(`
    CREATE INDEX IF NOT EXISTS users_stripe_subscription_id_idx ON users (stripe_subscription_id)
  `);
}

/**
 * Run migrations from migrations/ folder.
 * Each migration runs once and is tracked in _migrations table.
 */
async function runFolderMigrations(client) {
  const migrationsDir = path.join(__dirname, 'migrations');

  // Skip if no migrations folder
  if (!fs.existsSync(migrationsDir)) {
    return;
  }

  // Get all migration files, sorted by name (timestamp prefix ensures order)
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  if (files.length === 0) {
    return;
  }

  // Get already-applied migrations
  const applied = await client.query('SELECT name FROM _migrations');
  const appliedNames = new Set(applied.rows.map(r => r.name));

  // Run pending migrations
  for (const file of files) {
    const migration = require(path.join(migrationsDir, file));
    const name = migration.name || file.replace('.js', '');

    if (appliedNames.has(name)) {
      continue; // Already applied
    }

    console.log(`Running migration: ${name}`);

    try {
      await client.query('BEGIN');
      await migration.up(client);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`Migration complete: ${name}`);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // The connection may already be gone after a transient database error.
      }
      const migrationError = new Error(`Migration failed (${name}): ${err.message}`);
      migrationError.code = err.code;
      throw migrationError;
    }
  }
}

if (require.main === module) {
  migrate().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
}

module.exports = { migrate };

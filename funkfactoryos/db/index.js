// Owns: PostgreSQL connection pool
// Does NOT own: query logic (that lives in route files for now), migrations
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

module.exports = pool;

// Migration: admin_users table — stores admin portal credentials with PBKDF2 password hashes and reset token fields
const crypto = require('crypto');

// Must produce the same output format as db/admin-users.js hashPassword()
// so verifyPassword() works during auth.
function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return `pbkdf2:${salt}:${derived.toString('hex')}`;
}

module.exports = {
  name: 'add_admin_users',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        role VARCHAR(50) DEFAULT 'admin',
        reset_token VARCHAR(255),
        reset_token_expires TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS admin_users_email_idx ON admin_users (email)`);

    // Seed admin account with the default admin password (ffmg2026)
    // Uses the same PBKDF2-SHA512 algorithm as db/admin-users.js so auth works
    const adminHash = hashPassword('ffmg2026');
    await client.query({
      text: `INSERT INTO admin_users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
      values: ['admin@funkfactorymediagroup.com', adminHash, 'FFMG Admin', 'admin']
    });
  }
};
// Migration: seed/fix admin_users admin entry
// Ensures admin@funkfactorymediagroup.com exists with a correct PBKDF2 hash.
// Safe to run multiple times — uses ON CONFLICT DO UPDATE.
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return `pbkdf2:${salt}:${derived.toString('hex')}`;
}

module.exports = {
  name: 'seed_admin_user',
  up: async (client) => {
    const adminHash = hashPassword('ffmg2026');
    await client.query({
      text: `INSERT INTO admin_users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)
             ON CONFLICT (email) DO UPDATE SET password_hash = $2, name = $3`,
      values: ['admin@funkfactorymediagroup.com', adminHash, 'FFMG Admin', 'admin']
    });
  }
};
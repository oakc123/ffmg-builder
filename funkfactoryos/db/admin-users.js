// Owns: admin_users table queries (reset tokens, password hash operations)
// Does NOT own: pool construction (db/index.js), admin portal routes (routes/admin-portal.js)
const crypto = require('crypto');
const pool = require('./index');

const HASH_ALGO = 'sha512';
const HASH_ITERATIONS = 100000;
const HASH_KEYLEN = 64;

// ── PASSWORD HASHING ──────────────────────────────────────────────────────────
// Uses PBKDF2 (built into Node.js, no external deps needed)

function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const derived = crypto.pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_ALGO);
  return `pbkdf2:${salt}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2:')) return false;
  const [, salt, hash] = stored.split(':');
  const derived = crypto.pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_ALGO);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derived);
}

// ── RESET TOKEN HELPERS ──────────────────────────────────────────────────────
// Tokens are stored as a hash (never store raw token)

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── DB QUERIES ───────────────────────────────────────────────────────────────

async function findAdminUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, name, role FROM admin_users WHERE email = $1 LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function findAdminUserById(id) {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, name, role FROM admin_users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function findAdminByResetToken(token) {
  const tokenHash = hashToken(token);
  const { rows } = await pool.query(
    `SELECT id, email, name, role FROM admin_users
     WHERE reset_token = $1 AND reset_token_expires > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function setResetToken(email) {
  // Returns { token, tokenHash } — caller stores tokenHash in DB, sends token to email
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  const { rows } = await pool.query(`
    UPDATE admin_users
    SET reset_token = $1, reset_token_expires = $2, updated_at = NOW()
    WHERE email = $3
    RETURNING id, email
  `, [tokenHash, expires, email]);
  return rows[0] ? { token, user: rows[0] } : null;
}

async function clearResetToken(token) {
  const tokenHash = hashToken(token);
  await pool.query(`
    UPDATE admin_users
    SET reset_token = NULL, reset_token_expires = NULL, updated_at = NOW()
    WHERE reset_token = $1
  `, [tokenHash]);
}

async function updatePasswordByToken(token, newPassword) {
  const user = await findAdminByResetToken(token);
  if (!user) return null;
  const newHash = hashPassword(newPassword);
  const { rows } = await pool.query(`
    UPDATE admin_users
    SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL, updated_at = NOW()
    WHERE id = $2
    RETURNING id, email
  `, [newHash, user.id]);
  return rows[0] || null;
}

async function updatePasswordById(id, newPassword) {
  const newHash = hashPassword(newPassword);
  const { rows } = await pool.query(`
    UPDATE admin_users
    SET password_hash = $1, updated_at = NOW()
    WHERE id = $2
    RETURNING id, email
  `, [newHash, id]);
  return rows[0] || null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  findAdminUserByEmail,
  findAdminUserById,
  findAdminByResetToken,
  setResetToken,
  clearResetToken,
  updatePasswordByToken,
  updatePasswordById
};
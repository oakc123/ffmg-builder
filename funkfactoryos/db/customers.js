// Owns: customer, magic_link_tokens, and project_progress queries; preview data on customers row
// Does NOT own: messages queries (db/messages.js), raw pool construction (db/index.js)
const pool = require('./index');
const crypto = require('crypto');

// Find a customer by email + customer_uuid match — used for magic link auth
async function findCustomerByEmailAndUUID(email, customerUuid) {
  const { rows } = await pool.query(
    `SELECT id, customer_uuid, job_id, email, name, business_name, package_tier, project_status
     FROM customers
     WHERE LOWER(email) = LOWER($1) AND customer_uuid = $2
     LIMIT 1`,
    [email, customerUuid]
  );
  return rows[0] || null;
}

// Find a customer by customer_uuid alone — for session validation and dashboard render
async function findCustomerByUUID(customerUuid) {
  const { rows } = await pool.query(
    `SELECT id, customer_uuid, job_id, email, name, business_name, package_tier, project_status,
            preview_url, preview_expires_at, preview_package, preview_pages_built, preview_built_at, preview_notes
     FROM customers
     WHERE customer_uuid = $1
     LIMIT 1`,
    [customerUuid]
  );
  return rows[0] || null;
}

// Find a customer by job_id — for message access validation
async function findCustomerByJobId(jobId) {
  const { rows } = await pool.query(
    `SELECT id, customer_uuid, job_id, email, name, business_name, package_tier, project_status
     FROM customers
     WHERE job_id = $1
     LIMIT 1`,
    [jobId]
  );
  return rows[0] || null;
}

// Create a customer row (called from intake submission)
async function createCustomer({ customerUuid, name, email, businessName, packageTier, jobId }) {
  const { rows } = await pool.query(
    `INSERT INTO customers (customer_uuid, name, email, business_name, package_tier, job_id, project_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'intake_received')
     ON CONFLICT (customer_uuid) DO UPDATE
       SET name = EXCLUDED.name,
           email = EXCLUDED.email,
           business_name = EXCLUDED.business_name,
           package_tier = EXCLUDED.package_tier,
           job_id = COALESCE(EXCLUDED.job_id, customers.job_id)
     RETURNING *`,
    [customerUuid, name, email, businessName || null, packageTier || null, jobId || null]
  );
  return rows[0];
}

// Store a token hash for a magic link
async function storeMagicLinkToken({ tokenHash, customerUuid, jobId, email, expiresAt }) {
  await pool.query(
    `INSERT INTO magic_link_tokens (token_hash, customer_uuid, job_id, email, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [tokenHash, customerUuid, jobId || null, email, expiresAt]
  );
}

// Look up a magic link token row by hash
async function findMagicLinkToken(tokenHash) {
  const { rows } = await pool.query(
    `SELECT id, token_hash, customer_uuid, job_id, email, expires_at, used
     FROM magic_link_tokens
     WHERE token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

// Mark a magic link token as used
async function markTokenUsed(tokenHash) {
  await pool.query(
    `UPDATE magic_link_tokens SET used = true WHERE token_hash = $1`,
    [tokenHash]
  );
}

// Get project progress entries for a customer_uuid
async function getProjectProgress(customerUuid) {
  const { rows } = await pool.query(
    `SELECT id, url, note, created_at
     FROM project_progress
     WHERE customer_uuid = $1
     ORDER BY created_at ASC`,
    [customerUuid]
  );
  return rows;
}

// Find a customer by job_id + customer_uuid — used by inbound webhooks to verify ownership
async function findCustomerByJobAndUUID(jobId, customerUuid) {
  const { rows } = await pool.query(
    `SELECT id, customer_uuid, job_id, email, name, business_name, package_tier, project_status,
            preview_url, preview_expires_at, preview_package, preview_pages_built, preview_built_at, preview_notes
     FROM customers
     WHERE job_id = $1 AND customer_uuid = $2
     LIMIT 1`,
    [jobId, customerUuid]
  );
  return rows[0] || null;
}

// Upsert preview data on the customer row and set project_status = 'preview_ready'
async function upsertCustomerPreview({ jobId, customerUuid, previewUrl, previewExpiresAt, pkg, pagesBuilt, builtAt, notes }) {
  const { rows } = await pool.query(
    `UPDATE customers
     SET preview_url          = $1,
         preview_expires_at   = $2,
         preview_package      = $3,
         preview_pages_built  = $4,
         preview_built_at     = $5,
         preview_notes        = $6,
         project_status       = 'preview_ready'
     WHERE job_id = $7 AND customer_uuid = $8
     RETURNING id, job_id, project_status, preview_url, preview_expires_at, preview_package, preview_pages_built, preview_built_at, preview_notes`,
    [
      previewUrl,
      previewExpiresAt ? new Date(previewExpiresAt) : null,
      pkg || null,
      pagesBuilt ? JSON.stringify(pagesBuilt) : null,
      builtAt ? new Date(builtAt) : null,
      notes || null,
      jobId,
      customerUuid
    ]
  );
  return rows[0] || null;
}

module.exports = {
  findCustomerByEmailAndUUID,
  findCustomerByUUID,
  findCustomerByJobId,
  findCustomerByJobAndUUID,
  createCustomer,
  storeMagicLinkToken,
  findMagicLinkToken,
  markTokenUsed,
  getProjectProgress,
  upsertCustomerPreview
};

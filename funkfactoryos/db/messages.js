// Owns: messages table queries
// Does NOT own: customer/auth queries (db/customers.js), raw pool construction (db/index.js)
// Does NOT own: preview data (stored on customers row via db/customers.js)
const pool = require('./index');

// Insert a new message from customer or agent
async function insertMessage({ jobId, customerUuid, from, body, sentAt }) {
  const { rows } = await pool.query(
    `INSERT INTO messages (job_id, customer_uuid, "from", body, sent_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING message_id, "from", body, sent_at, read`,
    [jobId, customerUuid, from, body, sentAt ? new Date(sentAt) : new Date()]
  );
  return rows[0];
}

// Get all messages for a job_id, ordered chronologically
async function getMessagesByJobId(jobId) {
  const { rows } = await pool.query(
    `SELECT message_id, "from", body, sent_at, read
     FROM messages
     WHERE job_id = $1
     ORDER BY sent_at ASC`,
    [jobId]
  );
  return rows;
}

// Mark agent messages as read for a given job
async function markAgentMessagesRead(jobId) {
  await pool.query(
    `UPDATE messages SET read = true
     WHERE job_id = $1 AND "from" = 'agent' AND read = false`,
    [jobId]
  );
}

// Mark customer messages as read for a given job (admin read them)
async function markCustomerMessagesRead(jobId) {
  await pool.query(
    `UPDATE messages SET read = true
     WHERE job_id = $1 AND "from" = 'customer' AND read = false`,
    [jobId]
  );
}

// Get all jobs that have messages, with last message preview and unread customer message count
// Used by admin messages page left panel
async function getJobsWithMessages() {
  const { rows } = await pool.query(
    `SELECT
       m.job_id,
       c.name AS business_name,
       c.email AS customer_email,
       c.customer_uuid,
       MAX(m.sent_at) AS last_message_at,
       (SELECT body FROM messages WHERE job_id = m.job_id ORDER BY sent_at DESC LIMIT 1) AS last_message_preview,
       (SELECT "from" FROM messages WHERE job_id = m.job_id ORDER BY sent_at DESC LIMIT 1) AS last_message_from,
       COUNT(CASE WHEN m."from" = 'customer' AND m.read = false THEN 1 END)::int AS unread_count
     FROM messages m
     LEFT JOIN customers c ON c.job_id = m.job_id
     GROUP BY m.job_id, c.name, c.email, c.customer_uuid
     ORDER BY last_message_at DESC`
  );
  return rows;
}

// Get customer email for a job (for sending reply notification)
async function getCustomerEmailByJobId(jobId) {
  const { rows } = await pool.query(
    `SELECT email, name FROM customers WHERE job_id = $1 LIMIT 1`,
    [jobId]
  );
  return rows[0] || null;
}

// Insert an agent message idempotently using external_message_id for dedup.
// Returns { message, alreadyExisted } — alreadyExisted=true means the message_id
// was already in the DB; caller should return 200 without re-inserting.
async function insertAgentMessageDedup({ jobId, customerUuid, body, sentAt, externalMessageId }) {
  // Check for existing message with this external_message_id first
  if (externalMessageId) {
    const existing = await pool.query(
      `SELECT message_id FROM messages WHERE external_message_id = $1 LIMIT 1`,
      [externalMessageId]
    );
    if (existing.rows.length > 0) {
      return { message: existing.rows[0], alreadyExisted: true };
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO messages (job_id, customer_uuid, "from", body, sent_at, external_message_id)
     VALUES ($1, $2, 'agent', $3, $4, $5)
     RETURNING message_id, "from", body, sent_at, read`,
    [jobId, customerUuid, body, sentAt ? new Date(sentAt) : new Date(), externalMessageId || null]
  );
  return { message: rows[0], alreadyExisted: false };
}

module.exports = {
  insertMessage,
  insertAgentMessageDedup,
  getMessagesByJobId,
  markAgentMessagesRead,
  markCustomerMessagesRead,
  getJobsWithMessages,
  getCustomerEmailByJobId
};

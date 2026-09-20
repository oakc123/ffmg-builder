// Owns: customer-facing message endpoints (POST /api/messages, GET /api/messages/:job_id)
//       inbound agent-reply webhook (POST /api/messages/agent-reply)
// Does NOT own: auth/session logic (routes/auth.js), customer record queries (db/customers.js)
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { requirePortalAuth } = require('./auth');
const { insertMessage, insertAgentMessageDedup, getMessagesByJobId, markAgentMessagesRead } = require('../db/messages');
const { findCustomerByJobId, findCustomerByJobAndUUID } = require('../db/customers');

// WHY hardcoded: env var reads were returning 403 at Render runtime during instance rollover.
// Identical hardcoded value works consistently — same pattern as intake.js.
const WEBHOOK_SECRET = 'ffmg-intake-2026';

// Fire-and-forget: sync customer message to external admin system.
// Never throws — webhook failures must not surface to the customer.
// WHY hardcoded: env var reads were returning 403 while the identical hardcoded
// value in routes/intake.js works fine — likely Render env encoding issue.
async function notifyMessageWebhook({ jobId, customerUuid, body, sentAt }) {
  const WEBHOOK_URL = 'https://intake.funkfactorymediagroup.com/messages';
  const WEBHOOK_SECRET = 'ffmg-intake-2026';
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Polsia-Secret': WEBHOOK_SECRET
      },
      body: JSON.stringify({
        job_id: jobId,
        customer_uuid: customerUuid,
        from: 'customer',
        body,
        sent_at: sentAt || new Date().toISOString()
      }),
      timeout: 8000
    });
    if (!res.ok) {
      // WHY: log response body on failure — 403 debug (May 2026) showed stale instances
      // were the root cause, but if it recurs the body reveals the server's rejection reason
      const errBody = await res.text().catch(() => '');
      console.error(`[Messages] Webhook responded ${res.status} — job_id: ${jobId} — body: ${errBody.slice(0, 200)} — local save unaffected`);
    } else {
      console.log(`[Messages] Webhook delivered — job_id: ${jobId} status: ${res.status}`);
    }
  } catch (err) {
    console.error(`[Messages] Webhook error (non-fatal) — job_id: ${jobId} body: "${body.slice(0, 60)}…" — ${err.message}`);
  }
}

// POST /api/messages
// Body: { job_id, customer_uuid, from, body, sent_at }
router.post('/', requirePortalAuth, async (req, res) => {
  const { job_id, customer_uuid, body, sent_at } = req.body;

  if (!job_id || !body) {
    return res.status(422).json({ error: 'job_id and body are required' });
  }

  if (body.trim().length === 0) {
    return res.status(422).json({ error: 'Message body cannot be empty' });
  }

  if (body.length > 500) {
    return res.status(422).json({ error: 'Message body exceeds 500 character limit' });
  }

  // Verify the authenticated user owns this job_id
  if (req.portal.job_id && req.portal.job_id !== job_id) {
    return res.status(403).json({ error: 'Not authorized for this job' });
  }

  // Verify customer_uuid matches session
  if (customer_uuid && customer_uuid !== req.portal.customer_uuid) {
    return res.status(403).json({ error: 'UUID mismatch' });
  }

  try {
    const message = await insertMessage({
      jobId: job_id,
      customerUuid: req.portal.customer_uuid,
      from: 'customer',
      body: body.trim(),
      sentAt: sent_at
    });

    console.log(`[Messages] Customer message saved — job_id: ${job_id}`);

    // Non-blocking webhook — fire and forget, response already sent
    notifyMessageWebhook({
      jobId: job_id,
      customerUuid: req.portal.customer_uuid,
      body: body.trim(),
      sentAt: sent_at || new Date().toISOString()
    });

    res.json({ message_id: message.message_id, received: true });
  } catch (err) {
    console.error('[Messages] Insert error:', err.message);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// GET /api/messages/:job_id
router.get('/:job_id', requirePortalAuth, async (req, res) => {
  const { job_id } = req.params;

  // Verify the authenticated user owns this job_id
  if (req.portal.job_id && req.portal.job_id !== job_id) {
    return res.status(403).json({ error: 'Not authorized for this job' });
  }

  try {
    const msgs = await getMessagesByJobId(job_id);
    // Mark agent messages as read on fetch
    await markAgentMessagesRead(job_id).catch(() => {});

    res.json({
      job_id,
      messages: msgs.map(m => ({
        message_id: m.message_id,
        from: m.from,
        body: m.body,
        sent_at: m.sent_at,
        read: m.read
      }))
    });
  } catch (err) {
    console.error('[Messages] Fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /api/messages/agent-reply
// Inbound webhook: homelab assistant pushes agent replies into the customer thread.
// Auth: X-Polsia-Secret header, constant-time compare.
// Idempotent on message_id — safe to retry.
router.post('/agent-reply', async (req, res) => {
  // Constant-time comparison prevents timing attacks
  const provided = req.headers['x-polsia-secret'] || '';
  const expected = WEBHOOK_SECRET;
  if (provided.length !== expected.length ||
      !require('crypto').timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    console.warn('[Messages] agent-reply: 403 bad secret');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { job_id, customer_uuid, message_id, body, sent_at } = req.body;

  if (!job_id || !customer_uuid || !message_id || !body || !sent_at) {
    return res.status(400).json({ error: 'job_id, customer_uuid, message_id, body, and sent_at are required' });
  }

  try {
    const customer = await findCustomerByJobAndUUID(job_id, customer_uuid);
    if (!customer) {
      console.warn(`[Messages] agent-reply: 404 — job_id: ${job_id} customer_uuid: ${customer_uuid}`);
      return res.status(404).json({ error: 'Job not found' });
    }

    const { message, alreadyExisted } = await insertAgentMessageDedup({
      jobId: job_id,
      customerUuid: customer_uuid,
      body: body.trim(),
      sentAt: sent_at,
      externalMessageId: message_id
    });

    if (alreadyExisted) {
      console.log(`[Messages] agent-reply: duplicate message_id ${message_id} — returning 200 idempotently`);
    } else {
      console.log(`[Messages] agent-reply: saved — job_id: ${job_id} message_id: ${message_id}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Messages] agent-reply error:', err.message);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

module.exports = router;

// Owns: inbound preview delivery webhook (POST /api/preview)
// Does NOT own: customer portal reads (routes/portal.js), message threads (routes/messages.js)
const express = require('express');
const router = express.Router();
const { findCustomerByJobAndUUID, upsertCustomerPreview } = require('../db/customers');

// WHY hardcoded: env var reads unreliable at Render runtime during instance rollover.
// Identical hardcoded value used for intake and message webhooks — consistent pattern.
const WEBHOOK_SECRET = 'ffmg-intake-2026';

// POST /api/preview
// Inbound webhook: homelab assistant signals a preview build is ready.
// Stores preview data on the customer row and sets project_status = 'preview_ready'.
// Auth: X-Polsia-Secret header, constant-time compare.
router.post('/', async (req, res) => {
  const provided = req.headers['x-polsia-secret'] || '';
  const expected = WEBHOOK_SECRET;
  if (provided.length !== expected.length ||
      !require('crypto').timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    console.warn('[Preview] 403 bad secret');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const {
    job_id,
    customer_uuid,
    status,
    preview_url,
    preview_expires_at,
    package: pkg,
    pages_built,
    built_at,
    notes
  } = req.body;

  const missing = ['job_id', 'customer_uuid', 'status', 'preview_url', 'preview_expires_at', 'package', 'pages_built', 'built_at']
    .filter(f => !req.body[f]);

  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  // Validate preview_url is a valid HTTPS URL — no format-specific checks.
  // WHY no format check: preview URLs migrated from subdomain-based to path-based
  // (e.g. https://preview.funkfactorymediagroup.com/job-id) as of 2026-05-13.
  try {
    const parsed = new URL(preview_url);
    if (parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'preview_url must use HTTPS' });
    }
  } catch (_) {
    return res.status(400).json({ error: 'preview_url is not a valid URL' });
  }

  try {
    const customer = await findCustomerByJobAndUUID(job_id, customer_uuid);
    if (!customer) {
      console.warn(`[Preview] 404 — job_id: ${job_id} customer_uuid: ${customer_uuid}`);
      return res.status(404).json({ error: 'Job not found' });
    }

    await upsertCustomerPreview({
      jobId: job_id,
      customerUuid: customer_uuid,
      previewUrl: preview_url,
      previewExpiresAt: preview_expires_at,
      pkg,
      pagesBuilt: pages_built,
      builtAt: built_at,
      notes: notes || null
    });

    console.log(`[Preview] Preview stored — job_id: ${job_id} url: ${preview_url}`);

    res.json({ received: true, job_id });
  } catch (err) {
    console.error('[Preview] Error storing preview:', err.message);
    res.status(500).json({ error: 'Failed to store preview' });
  }
});

module.exports = router;

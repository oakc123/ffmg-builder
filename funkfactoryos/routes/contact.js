// Owns: FFMG contact/booking form submissions
// Does NOT own: intake submissions, pets orders, admin auth
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const pool = require('../db');
const db = require('../db/admin');
const dbExpressNurture = require('../db/express-nurture');

// Stage 1 nurture trigger — fires immediately on successful contact form submit.
// Posts to the Klaviyo Track Event webhook and records the local send row so
// the cron job can skip already-processed contacts at Stages 2 and 3. Never
// blocks the user-facing POST — fire-and-forget per the createNotification
// pattern below. When KLAVIYO_WEBHOOK_URL is unset (sandbox / pre-Klaviyo),
// we still record the send so the Days-3/7 cron path can be dry-run-verified
// locally without a live webhook target.
async function triggerStage1(submission) {
  const webhook = process.env.KLAVIYO_WEBHOOK_URL;
  let eventId = null;

  if (webhook) {
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'FFMG Express Lead Submitted',
          email: submission.email,
          first_name: submission.first_name,
          contact_id: submission.contact_id
        }),
        timeout: 5000
      });
      if (!res.ok) {
        console.error(`[Express Nurture] Stage 1 webhook returned ${res.status} for ${submission.email}`);
      } else {
        try {
          const data = await res.json();
          eventId = data.event_id || data.id || null;
        } catch (_) { /* response wasn't JSON — recordSend tolerates null */ }
      }
    } catch (err) {
      console.error(`[Express Nurture] Stage 1 dispatch error for ${submission.email}: ${err.message}`);
    }
  } else {
    console.log(`[Express Nurture] KLAVIYO_WEBHOOK_URL unset — skipping webhook post for ${submission.email}`);
  }

  try {
    await dbExpressNurture.recordSend(submission.contact_id, 1, eventId);
    console.log(`[Express Nurture] Stage 1 recorded for ${submission.email} (contact_id=${submission.contact_id})`);
  } catch (err) {
    console.error(`[Express Nurture] Stage 1 recordSend error for ${submission.email}: ${err.message}`);
  }
}

// POST /api/contact — save booking inquiry to contact_submissions
router.post('/', async (req, res) => {
  try {
    const { name, email, phone, event_type, event_date, venue, message,
            utm_source, utm_medium, utm_campaign, referrer, cta_variant, pricing_variant_source } = req.body;

    if (!name || !email || !event_type || !message) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }

    const allowedVariants = new Set(['linkedin', 'twitter', 'direct', 'google']);
    const safePricingVariant = pricing_variant_source && allowedVariants.has(String(pricing_variant_source))
      ? String(pricing_variant_source).slice(0, 20)
      : null;

    const insertResult = await pool.query(
      `INSERT INTO contact_submissions (name, email, phone, event_type, event_date, venue, message, utm_source, utm_medium, utm_campaign, referrer, cta_variant, pricing_variant_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [name, email, phone || null, event_type, event_date || null, venue || null, message, utm_source || null, utm_medium || null, utm_campaign || null, referrer || null, cta_variant || null, safePricingVariant]
    );
    const contact_id = insertResult.rows[0] && insertResult.rows[0].id;

    const utmTag = utm_source ? ` [src: ${utm_source}]` : '';
    console.log(`[Contact] New booking request from ${name} <${email}> — ${event_type}${utmTag}`);

    if (utm_source) {
      db.createNotification({
        type: 'contact_lead',
        job_id: null,
        business_name: name,
        message: `[Contact] New lead from ${utm_source}: ${name} — ${event_type}`
      }).catch(() => {});
    }

    // Fire-and-forget Stage 1 express-lead-nurture trigger.
    // Resolves immediately; webhook post + recordSend happen async inside.
    triggerStage1({
      contact_id,
      email,
      first_name: (name || '').trim().split(/\s+/)[0] || ''
    }).catch((err) => console.error('[Express Nurture] Stage 1 outer error:', err.message));

    res.json({ success: true, message: 'Booking request received' });
  } catch (err) {
    console.error('[Contact] Error saving submission:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

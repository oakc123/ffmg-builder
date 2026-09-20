// Owns: first-party page view tracking (public write endpoint)
// Does NOT own: admin analytics dashboard (that lives in admin.js)
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');

// POST /api/analytics/pageview — record a page view (no auth, respects DNT)
router.post('/pageview', async (req, res) => {
  try {
    // Respect Do Not Track
    if (req.headers.dnt === '1') return res.status(204).end();

    const { path: pagePath, referrer, utm_source, utm_medium, utm_campaign, utm_content, pricing_variant_source } = req.body;
    if (!pagePath) return res.status(204).end();

    // Derive a stable visitor_id from hashed IP + User-Agent (no PII stored)
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';
    const visitorId = crypto.createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 16);

    // Country from Cloudflare/Render header (best-effort)
    const country = req.headers['cf-ipcountry'] || req.headers['x-country-code'] || null;

    // Determine which site this came from
    const host = (req.headers.host || '').replace(/^www\./, '').replace(/:\d+$/, '');
    const site = host === 'funkfactorypets.com' ? 'pets' : 'ffmg';

    const allowedVariants = new Set(['linkedin', 'twitter', 'direct', 'google']);
    const safePath = String(pagePath).slice(0, 500);
    const safeReferrer = referrer ? String(referrer).slice(0, 1000) : null;
    const safeUA = ua ? ua.slice(0, 500) : null;
    const safeUtmSource   = utm_source   ? String(utm_source).slice(0, 200)   : null;
    const safeUtmMedium   = utm_medium   ? String(utm_medium).slice(0, 200)   : null;
    const safeUtmCampaign = utm_campaign ? String(utm_campaign).slice(0, 200) : null;
    const safeUtmContent  = utm_content  ? String(utm_content).slice(0, 200)  : null;
    const safePricingVariant = pricing_variant_source && allowedVariants.has(String(pricing_variant_source))
      ? String(pricing_variant_source).slice(0, 20)
      : null;

    await pool.query(
      `INSERT INTO page_views (visitor_id, page_path, referrer, user_agent, country, site,
                               utm_source, utm_medium, utm_campaign, utm_content, pricing_variant_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [visitorId, safePath, safeReferrer, safeUA, country, site,
       safeUtmSource, safeUtmMedium, safeUtmCampaign, safeUtmContent, safePricingVariant]
    );

    res.status(204).end();
  } catch (err) {
    // Never let analytics errors surface to users
    console.error('[Analytics] pageview error:', err.message);
    res.status(204).end();
  }
});

// POST /api/analytics/social-proof-viewed — record a [data-social-proof] placement view (no auth, respects DNT)
router.post('/social-proof-viewed', async (req, res) => {
  try {
    if (req.headers.dnt === '1') return res.status(204).end();
    const { placement, path: pagePath } = req.body;
    if (!placement || !pagePath) return res.status(204).end();

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';
    const visitorId = crypto.createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 16);

    await pool.query(
      `INSERT INTO social_proof_events (placement, page_path, visitor_id)
       VALUES ($1, $2, $3)`,
      [String(placement).slice(0, 64), String(pagePath).slice(0, 500), visitorId]
    );
    res.status(204).end();
  } catch (err) {
    console.error('[Analytics] social-proof-viewed error:', err.message);
    res.status(204).end();
  }
});

// GET /api/analytics/stats — real counts for homepage hero stats strip
router.get('/stats', async (req, res) => {
  try {
    const [eventsResult, customersResult, oldestResult, photosResult] = await Promise.all([
      pool.query('SELECT COUNT(*)::int FROM contact_submissions'),
      pool.query('SELECT COUNT(*)::int FROM customers'),
      pool.query('SELECT MIN(created_at) FROM customers'),
      pool.query('SELECT COUNT(*)::int FROM gallery_photos')
    ]);

    const events_captured = eventsResult.rows[0]?.count ?? 0;
    const clients_served = customersResult.rows[0]?.count ?? 0;
    const years_in_business = oldestResult.rows[0]?.min
      ? new Date(oldestResult.rows[0].min).getFullYear()
      : 2019;
    const photos_delivered = photosResult.rows[0]?.count ?? 0;

    res.json({
      events_captured,
      clients_served,
      years_in_business: 2026 - years_in_business,
      photos_delivered
    });
  } catch (err) {
    console.error('[Analytics] stats error:', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

module.exports = router;

// Owns: admin auth, gallery CRUD, file upload, gig tracker, order management, analytics dashboard
// Does NOT own: public API endpoints, pets checkout, contact/intake forms
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const pool = require('../db');

// ── AUTH HELPERS ──────────────────────────────────────────────────────────────
function getAdminToken() {
  const password = process.env.ADMIN_PASSWORD || 'ffmg-admin';
  const secret = process.env.JWT_SECRET || 'ffmg-secret';
  return crypto.createHmac('sha256', secret).update(password).digest('hex');
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.admin_session === getAdminToken()) return next();
  res.status(401).json({ success: false, message: 'Unauthorized' });
}

// Upload helper — forwards buffer to Polsia R2 proxy
async function uploadToR2(fileBuffer, filename, mimeType) {
  const formData = new FormData();
  formData.append('file', fileBuffer, { filename, contentType: mimeType });
  const response = await fetch('https://polsia.com/api/proxy/r2/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.POLSIA_API_KEY}`, ...formData.getHeaders() },
    body: formData
  });
  const result = await response.json();
  if (!result.success) throw new Error(result.error?.message || 'R2 upload failed');
  return result.file.url;
}

// Multer — memory storage for all admin uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'ffmg-admin';
  if (!password || password !== adminPassword) {
    return res.status(401).json({ success: false, message: 'Wrong password' });
  }
  const token = getAdminToken();
  const isSecure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie',
    `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${isSecure ? '; Secure' : ''}`
  );
  res.json({ success: true });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ success: true });
});

router.get('/check', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  res.json({ success: true, authenticated: cookies.admin_session === getAdminToken() });
});

// ── UPLOAD ROUTES ─────────────────────────────────────────────────────────────
router.post('/upload', requireAdmin, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });
    const url = await uploadToR2(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json({ success: true, url });
  } catch (err) {
    console.error('[Upload] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GALLERY MANAGEMENT ────────────────────────────────────────────────────────
router.get('/gallery', async (req, res) => {
  // Public read endpoint (mounted under /api/gallery in server.js, not here)
  // This route should not conflict — see server.js for public /api/gallery
  res.status(404).end();
});

router.post('/gallery', requireAdmin, async (req, res) => {
  try {
    const { url, caption, category } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'URL is required' });
    const validCategories = ['football', 'basketball', 'sports', 'concerts'];
    const cat = validCategories.includes(category) ? category : 'sports';
    const maxResult = await pool.query('SELECT COALESCE(MAX(sort_order), 0) as max FROM gallery_photos');
    const sortOrder = maxResult.rows[0].max + 1;
    const result = await pool.query(
      'INSERT INTO gallery_photos (url, caption, category, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [url, caption || '', cat, sortOrder]
    );
    console.log(`[Gallery] Added photo: ${url} (${cat})`);
    res.json({ success: true, photo: result.rows[0] });
  } catch (err) {
    console.error('[Gallery] Error adding photo:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/gallery/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM gallery_photos WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Photo not found' });
    console.log(`[Gallery] Deleted photo #${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Gallery] Error deleting photo:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/gallery/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { caption, category } = req.body;
    const validCategories = ['football', 'basketball', 'sports', 'concerts'];
    const updates = [];
    const params = [];
    let paramIdx = 1;
    if (caption !== undefined) { updates.push(`caption = $${paramIdx++}`); params.push(caption); }
    if (category && validCategories.includes(category)) { updates.push(`category = $${paramIdx++}`); params.push(category); }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'Nothing to update' });
    params.push(id);
    const result = await pool.query(
      `UPDATE gallery_photos SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`, params
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Photo not found' });
    res.json({ success: true, photo: result.rows[0] });
  } catch (err) {
    console.error('[Gallery] Error updating photo:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/gallery/reorder', requireAdmin, async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ success: false, message: 'order must be an array' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of order) {
        await client.query('UPDATE gallery_photos SET sort_order = $1 WHERE id = $2', [item.sort_order, item.id]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Gallery] Error reordering:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GIGS MANAGEMENT ───────────────────────────────────────────────────────────
const VALID_GIG_TYPES = ['concert', 'corporate', 'podcast', 'social_content'];
const VALID_GIG_STATUSES = ['inquiry', 'confirmed', 'completed', 'invoiced', 'paid'];

router.get('/gigs', requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = `SELECT * FROM gigs`;
    const params = [];
    if (status && status !== 'all' && VALID_GIG_STATUSES.includes(status)) {
      query += ` WHERE status = $1`;
      params.push(status);
    }
    query += ` ORDER BY event_date ASC NULLS LAST, created_at DESC`;
    const result = await pool.query(query, params);
    res.json({ success: true, gigs: result.rows });
  } catch (err) {
    console.error('[Gigs] Error listing:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/gigs/stats', requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [upcoming, paidRev, pendingInv] = await Promise.all([
      pool.query(`SELECT COUNT(*) as count FROM gigs WHERE event_date >= $1 AND status NOT IN ('paid','completed')`, [today]),
      pool.query(`SELECT COALESCE(SUM(price), 0) as total FROM gigs WHERE status = 'paid'`),
      pool.query(`SELECT COALESCE(SUM(price), 0) as total, COUNT(*) as count FROM gigs WHERE status = 'invoiced'`)
    ]);
    res.json({
      success: true,
      upcoming_gigs: parseInt(upcoming.rows[0].count),
      total_revenue: parseFloat(paidRev.rows[0].total),
      pending_invoices: parseFloat(pendingInv.rows[0].total),
      pending_invoice_count: parseInt(pendingInv.rows[0].count)
    });
  } catch (err) {
    console.error('[Gigs] Error stats:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/gigs', requireAdmin, async (req, res) => {
  try {
    const { client_name, event_name, event_type, event_date, location, status, price, notes, contact_email, contact_phone } = req.body;
    if (!client_name || !event_name) return res.status(400).json({ success: false, message: 'client_name and event_name are required' });
    const gigType = VALID_GIG_TYPES.includes(event_type) ? event_type : 'concert';
    const gigStatus = VALID_GIG_STATUSES.includes(status) ? status : 'inquiry';
    const result = await pool.query(
      `INSERT INTO gigs (client_name, event_name, event_type, event_date, location, status, price, notes, contact_email, contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [client_name, event_name, gigType, event_date || null, location || null, gigStatus,
       price ? parseFloat(price) : null, notes || null, contact_email || null, contact_phone || null]
    );
    console.log(`[Gigs] Created gig #${result.rows[0].id}: ${event_name} for ${client_name}`);
    res.json({ success: true, gig: result.rows[0] });
  } catch (err) {
    console.error('[Gigs] Error creating:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/gigs/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { client_name, event_name, event_type, event_date, location, status, price, notes, contact_email, contact_phone } = req.body;
    const fields = [];
    const params = [];
    let idx = 1;
    if (client_name !== undefined) { fields.push(`client_name=$${idx++}`); params.push(client_name); }
    if (event_name !== undefined) { fields.push(`event_name=$${idx++}`); params.push(event_name); }
    if (event_type !== undefined && VALID_GIG_TYPES.includes(event_type)) { fields.push(`event_type=$${idx++}`); params.push(event_type); }
    if (event_date !== undefined) { fields.push(`event_date=$${idx++}`); params.push(event_date || null); }
    if (location !== undefined) { fields.push(`location=$${idx++}`); params.push(location); }
    if (status !== undefined && VALID_GIG_STATUSES.includes(status)) { fields.push(`status=$${idx++}`); params.push(status); }
    if (price !== undefined) { fields.push(`price=$${idx++}`); params.push(price ? parseFloat(price) : null); }
    if (notes !== undefined) { fields.push(`notes=$${idx++}`); params.push(notes); }
    if (contact_email !== undefined) { fields.push(`contact_email=$${idx++}`); params.push(contact_email); }
    if (contact_phone !== undefined) { fields.push(`contact_phone=$${idx++}`); params.push(contact_phone); }
    if (fields.length === 0) return res.status(400).json({ success: false, message: 'Nothing to update' });
    fields.push(`updated_at=NOW()`);
    params.push(id);
    const result = await pool.query(`UPDATE gigs SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`, params);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Gig not found' });
    res.json({ success: true, gig: result.rows[0] });
  } catch (err) {
    console.error('[Gigs] Error updating:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/gigs/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM gigs WHERE id=$1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Gig not found' });
    console.log(`[Gigs] Deleted gig #${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Gigs] Error deleting:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── ORDERS ────────────────────────────────────────────────────────────────────
router.get('/pets/orders', requireAdmin, async (req, res) => {
  try {
    const { status, limit = 100, offset = 0 } = req.query;
    const params = [];
    let where = '';
    if (status && status !== 'all') {
      params.push(status);
      where = `WHERE o.status = $${params.length}`;
    }
    params.push(parseInt(limit) || 100);
    params.push(parseInt(offset) || 0);
    const result = await pool.query(
      `SELECT o.*,
              json_agg(json_build_object(
                'id', oi.id,
                'product_name', oi.product_name,
                'quantity', oi.quantity,
                'unit_price_cents', oi.unit_price_cents
              ) ORDER BY oi.id) as items
       FROM pet_orders o
       LEFT JOIN pet_order_items oi ON oi.order_id = o.id
       ${where}
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM pet_orders ${where}`,
      status && status !== 'all' ? [status] : []
    );
    res.json({ success: true, orders: result.rows, total: parseInt(countResult.rows[0].total) });
  } catch (err) {
    console.error('[Admin Orders] Error fetching orders:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/pets/orders/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, cj_order_id, fulfillment_notes } = req.body;
    const validStatuses = ['pending', 'paid', 'fulfilled', 'shipped', 'cancelled'];
    const updates = [];
    const params = [];
    let idx = 1;
    if (status && validStatuses.includes(status)) { updates.push(`status = $${idx++}`); params.push(status); }
    if (cj_order_id !== undefined) { updates.push(`cj_order_id = $${idx++}`); params.push(cj_order_id || null); }
    if (fulfillment_notes !== undefined) { updates.push(`fulfillment_notes = $${idx++}`); params.push(fulfillment_notes || null); }
    if (!updates.length) return res.status(400).json({ success: false, message: 'Nothing to update' });
    updates.push(`updated_at = NOW()`);
    params.push(id);
    const result = await pool.query(
      `UPDATE pet_orders SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Order not found' });
    console.log(`[Admin Orders] Order #${id} updated: status=${result.rows[0].status}`);
    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error('[Admin Orders] Error updating order:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── ANALYTICS DASHBOARD ───────────────────────────────────────────────────────
router.get('/analytics', requireAdmin, async (req, res) => {
  try {
    const [totalsResult, uniqueResult, topPagesResult, referrerResult, dailyResult, siteResult, utmSourceResult, utmTotalsResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') AS today, COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS week, COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS month, COUNT(*) AS total FROM page_views`),
      pool.query(`SELECT COUNT(DISTINCT visitor_id) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') AS today, COUNT(DISTINCT visitor_id) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS week, COUNT(DISTINCT visitor_id) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS month FROM page_views`),
      pool.query(`SELECT page_path, COUNT(*) AS views FROM page_views WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY page_path ORDER BY views DESC LIMIT 15`),
      pool.query(`SELECT CASE WHEN referrer IS NULL OR referrer = '' THEN 'direct' WHEN referrer ~* '(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia|ask\\.com)' THEN 'search' WHEN referrer ~* '(facebook|instagram|twitter|x\\.com|tiktok|linkedin|pinterest|reddit|youtube|snapchat)' THEN 'social' WHEN referrer ~* '(mail|gmail|yahoo|outlook|hotmail|thunderbird|mailchimp|klaviyo|sendgrid)' THEN 'email' ELSE 'other' END AS source, COUNT(*) AS views FROM page_views WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY source ORDER BY views DESC`),
      pool.query(`SELECT DATE_TRUNC('day', created_at AT TIME ZONE 'UTC') AS day, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS unique_visitors FROM page_views WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1 ASC`),
      pool.query(`SELECT site, COUNT(*) AS views FROM page_views WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY site ORDER BY views DESC`),
      pool.query(`SELECT utm_source, utm_medium, utm_campaign, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS unique_visitors FROM page_views WHERE created_at >= NOW() - INTERVAL '30 days' AND utm_source IS NOT NULL GROUP BY utm_source, utm_medium, utm_campaign ORDER BY views DESC LIMIT 50`),
      pool.query(`SELECT utm_source, COUNT(*) AS views FROM page_views WHERE created_at >= NOW() - INTERVAL '30 days' AND utm_source IS NOT NULL GROUP BY utm_source ORDER BY views DESC`)
    ]);
    res.json({
      success: true,
      totals: totalsResult.rows[0],
      unique: uniqueResult.rows[0],
      topPages: topPagesResult.rows,
      referrerBreakdown: referrerResult.rows,
      dailyTrend: dailyResult.rows,
      bySite: siteResult.rows,
      utmBreakdown: utmSourceResult.rows,
      utmSourceTotals: utmTotalsResult.rows
    });
  } catch (err) {
    console.error('[Analytics] admin stats error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

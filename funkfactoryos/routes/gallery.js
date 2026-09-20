// Owns: public gallery read endpoint and sitemap/robots SEO routes
// Does NOT own: admin gallery CRUD (admin.js), pets store SEO
const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/gallery — public gallery listing with optional category filter
router.get('/', async (req, res) => {
  try {
    const { category } = req.query;
    let query = 'SELECT id, url, caption, category, sort_order, created_at FROM gallery_photos';
    const params = [];
    if (category && category !== 'all') { query += ' WHERE category = $1'; params.push(category); }
    query += ' ORDER BY sort_order ASC, created_at DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, photos: result.rows });
  } catch (err) {
    console.error('[Gallery] Error fetching photos:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

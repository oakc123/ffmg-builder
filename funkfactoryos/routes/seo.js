// Owns: /sitemap.xml and /robots.txt — SEO discovery endpoints for funkfactoryos.polsia.app
// Also serves Funk Factory Pets domain sitemap/robots via domain routing in server.js
// Does NOT own: page content, meta tags, structured data
const express = require('express');
const router = express.Router();
const pool = require('../db');
const caseStudiesDb = require('../db/case-studies');

router.get('/robots.txt', (req, res) => {
  const host = (req.headers.host || '').replace(/^www\./, '').replace(/:\d+$/, '');
  if (host.toLowerCase() === 'funkfactorypets.com') {
    return res.type('text/plain').send('User-agent: *\nAllow: /\n\nSitemap: https://funkfactorypets.com/sitemap.xml\n');
  }
  res.type('text/plain').send(
    'User-agent: *\nAllow: /\nDisallow: /intake\nDisallow: /thanks\nDisallow: /api/\nDisallow: /admin/\n\nSitemap: https://funkfactoryos.polsia.app/sitemap.xml\n'
  );
});

router.get('/sitemap.xml', async (req, res) => {
  const host = (req.headers.host || '').replace(/^www\./, '').replace(/:\d+$/, '');

  // Funk Factory Pets domain — serve pets sitemap
  if (host.toLowerCase() === 'funkfactorypets.com') {
    const BASE = 'https://funkfactorypets.com';
    const today = new Date().toISOString().split('T')[0];
    const staticPages = [
      { url: '/',         priority: '1.0', changefreq: 'weekly'  },
      { url: '/shop',     priority: '0.9', changefreq: 'weekly'  },
      { url: '/about',    priority: '0.5', changefreq: 'monthly' },
      { url: '/shipping', priority: '0.4', changefreq: 'monthly' },
      { url: '/returns',  priority: '0.4', changefreq: 'monthly' },
    ];
    let productPages = [];
    try {
      const result = await pool.query('SELECT slug FROM pet_products ORDER BY id');
      productPages = result.rows.map(p => ({
        url: `/product?slug=${encodeURIComponent(p.slug)}`, priority: '0.8', changefreq: 'weekly'
      }));
    } catch (e) { console.error('[Sitemap] DB error:', e.message); }
    const urlEntries = [...staticPages, ...productPages].map(p =>
      `  <url>\n    <loc>${BASE}${p.url}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
    ).join('\n');
    return res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`
    );
  }

  // FFMG main domain sitemap
  const baseUrl = 'https://funkfactoryos.polsia.app';
  const lastmod = new Date().toISOString().split('T')[0];
  const pages = [
    '/',
    '/services',
    '/portfolio',
    '/work',
    '/what-we-offer',
    '/intake',
    '/ffmg-express',
    '/ffmg-express/pricing',
    '/contact',
    '/thanks',
    '/about',
    '/blog',
    '/podcast',
    '/blog/concert-videographer-albuquerque',
    '/blog/event-photography-packages-new-mexico'
  ];

  const urls = pages.map(path => `
  <url>
    <loc>${baseUrl}${path}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${path === '/' ? 'weekly' : 'monthly'}</changefreq>
    <priority>${path === '/' ? '1.0' : '0.8'}</priority>
  </url>`).join('');

  // Case-study detail URLs come from the same case_studies table the /work
  // hub reads. lastmod pulls from created_at so the sitemap reflects when
  // each detail page actually appeared. Wrapped in try/catch so a DB hiccup
  // never blocks the sitemap.
  let caseStudyEntries = '';
  try {
    const rows = await caseStudiesDb.listCaseStudiesForSitemap();
    caseStudyEntries = rows.map(r => {
      const stamp = r.created_at
        ? new Date(r.created_at).toISOString().split('T')[0]
        : lastmod;
      return `
  <url>
    <loc>${baseUrl}/work/${encodeURIComponent(r.slug)}</loc>
    <lastmod>${stamp}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`;
    }).join('');
  } catch (e) { console.error('[Sitemap] case_studies query failed:', e.message); }

  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}${caseStudyEntries}
</urlset>`);
});

module.exports = router;

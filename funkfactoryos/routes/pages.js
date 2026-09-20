// Owns: FFMG HTML page routes — homepage, services, portfolio, what-we-offer, intake, podcast page
// Does NOT own: API endpoints, pets store pages, admin panel routes
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { renderNotFound } = require('./not-found');

const DEFAULT_PUBLIC_ORIGIN = 'https://funkfactoryos.polsia.app';

function getPublicOrigin() {
  const configuredOrigin = String(process.env.APP_URL || '').trim();
  try {
    const origin = new URL(configuredOrigin || DEFAULT_PUBLIC_ORIGIN);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return DEFAULT_PUBLIC_ORIGIN;
    return origin.origin;
  } catch (err) {
    return DEFAULT_PUBLIC_ORIGIN;
  }
}

function getCanonicalUrl(routePath) {
  const origin = getPublicOrigin();
  const suppliedPath = String(routePath || '/');
  const normalizedPath = suppliedPath.startsWith('/') ? suppliedPath : '/' + suppliedPath;
  return origin + (new URL(normalizedPath, origin).pathname || '/');
}

// GET /blog — blog index listing
router.get('/blog', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'blog', 'index.html'));
});

// GET /podcast — public podcast landing page and episode archive
router.get('/podcast', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'podcast.html'));
});

// GET /blog/concert-videographer-albuquerque — SEO article 1
router.get('/blog/concert-videographer-albuquerque', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'blog', 'concert-videographer-albuquerque.html'));
});

// GET /blog/event-photography-packages-new-mexico — SEO article 2
router.get('/blog/event-photography-packages-new-mexico', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'blog', 'event-photography-packages-new-mexico.html'));
});

// GET /about — company story, values, and services overview
router.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'about.html'));
});

// GET /portfolio — case studies and past work showcase
router.get('/portfolio', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'portfolio.html'));
});

// GET /work — portfolio hub: 6 case-study tiles rendered client-side from /api/work
router.get('/work', (req, res) => {
  const htmlPath = path.join(__dirname, '..', 'public', 'work.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__CANONICAL__', escapeHtml(getCanonicalUrl('/work')));
    res.type('html').send(html);
  } else {
    res.sendFile(htmlPath);
  }
});

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Renders a single case_studies row into the .case-card tile markup used on
// /work (see public/work.html:613-645). Mirrors that renderer character-for-
// character so the homepage rail reads as the same surface as the hub.
function renderCaseStudyTile(row) {
  const slug = encodeURIComponent(row.slug || '');
  const badge = (Array.isArray(row.service_tags) && row.service_tags.length)
    ? escapeHtml(row.service_tags[0])
    : 'Case Study';
  const client = escapeHtml(row.client || '');
  const title = escapeHtml(row.title || '');
  const desc = escapeHtml(row.summary || '');
  const img = escapeHtml(row.cover_image_url || '');
  return [
    '<a class="case-card" href="/work/' + slug + '">',
      '<div class="case-card-thumb">',
        '<img src="' + img + '" alt="' + title + '" loading="lazy">',
        '<div class="case-card-thumb-overlay"></div>',
        '<span class="case-badge">' + badge + '</span>',
      '</div>',
      '<div class="case-card-body">',
        '<div class="case-client">' + client + '</div>',
        '<h2 class="case-title">' + title + '</h2>',
        '<p class="case-desc">' + desc + '</p>',
        '<span class="case-cta">Read the case study <span class="case-cta-arrow">→</span></span>',
      '</div>',
    '</a>'
  ].join('\n');
}

// GET /work/:slug — case study detail page. Server-renders the row from
// case_studies into public/work/detail.html via string-replace placeholders.
router.get('/work/:slug', async (req, res) => {
  const rawSlug = String(req.params.slug || '');
  if (!rawSlug || !/^[a-z0-9-]+$/i.test(rawSlug)) return renderNotFound(req, res);

  let row;
  try {
    row = await require('../db/case-studies').getCaseStudyBySlug(rawSlug);
  } catch (err) {
    console.error('[work/:slug] db error:', err.message);
    return res.redirect('/work');
  }
  if (!row) return renderNotFound(req, res);

  const htmlPath = path.join(__dirname, '..', 'public', 'work', 'detail.html');
  if (!fs.existsSync(htmlPath)) return res.redirect('/work');
  let html = fs.readFileSync(htmlPath, 'utf8');

  const gaId = process.env.GA4_MEASUREMENT_ID || '';
  const canonicalSlug = encodeURIComponent(String(row.slug || ''));
  const ogUrl = getCanonicalUrl('/work/' + canonicalSlug);
  const narrative = row.narrative || {};
  const safe = (v) => escapeHtml(v);
  // JSON-LD strings must be JSON-safe (not HTML-escaped) so schema.org
  // parsers don't read `&amp;` literally. JSON.stringify produces a quoted,
  // escape-correct JSON literal — we drop it straight into the JSON tree.
  const jsonStr = (v) => JSON.stringify(v == null ? '' : String(v));

  html = html
    .replaceAll('__TITLE__', safe(row.title))
    .replaceAll('__META_DESCRIPTION__', safe(row.summary || ''))
    .replaceAll('__OG_TITLE__', safe(row.title))
    .replaceAll('__OG_DESCRIPTION__', safe(row.summary || ''))
    .replaceAll('__OG_IMAGE__', safe(row.cover_image_url))
    .replaceAll('__OG_URL__', safe(ogUrl))
    .replaceAll('__CANONICAL__', safe(ogUrl))
    .replaceAll('__HERO_IMAGE__', safe(row.cover_image_url))
    .replaceAll('__CLIENT__', safe(row.client))
    .replaceAll('__SERVICE_TAGS_JSON__', JSON.stringify(row.service_tags || []))
    .replaceAll('__NARRATIVE_CHALLENGE__', safe(narrative.challenge || ''))
    .replaceAll('__NARRATIVE_APPROACH__', safe(narrative.approach || ''))
    .replaceAll('__NARRATIVE_RESULTS__', safe(narrative.results || ''))
    .replaceAll('__SLUG__', safe(rawSlug))
    .replaceAll('__GA4_ID__', safe(gaId))
    .replaceAll('__TITLE_JSON__', jsonStr(row.title))
    .replaceAll('__OG_IMAGE_JSON__', jsonStr(row.cover_image_url));

  res.type('html').send(html);
});

// GET /contact — contact form page with GA4 measurement ID injection
router.get('/contact', (req, res) => {
  const gaId = process.env.GA4_MEASUREMENT_ID || '';
  const htmlPath = path.join(__dirname, '..', 'public', 'contact.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__GA4_ID__', gaId);
    res.type('html').send(html);
  } else {
    res.redirect('/');
  }
});

// GET /thanks — post-submission confirmation page (FFMG Express) with GA4 measurement ID injection
router.get('/thanks', (req, res) => {
  const gaId = process.env.GA4_MEASUREMENT_ID || '';
  const htmlPath = path.join(__dirname, '..', 'public', 'thanks.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__GA4_ID__', gaId);
    res.type('html').send(html);
  } else {
    res.redirect('/');
  }
});

// GET /intake/thanks — client intake post-submission confirmation page
router.get('/intake/thanks', (req, res) => {
  const gaId = process.env.GA4_MEASUREMENT_ID || '';
  const htmlPath = path.join(__dirname, '..', 'public', 'intake-thanks.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__GA4_ID__', gaId);
    res.type('html').send(html);
  } else {
    res.redirect('/intake');
  }
});

// GET /ffmg-express/pricing — pricing transparency micro-landing page (FFMG Express) with GA4 measurement ID injection
router.get('/ffmg-express/pricing', (req, res) => {
  const gaId = process.env.GA4_MEASUREMENT_ID || '';
  const htmlPath = path.join(__dirname, '..', 'public', 'ffmg-express', 'pricing.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__GA4_ID__', gaId);
    res.type('html').send(html);
  } else {
    res.redirect('/');
  }
});

// GET /ffmg-express — FFMG Express landing page (OG/Twitter share preview surface) with GA4 measurement ID injection
// and UTM-source variant branching of the OG/Twitter copy so LinkedIn/X unfurls (which don't run JS) see
// the matching branded preview for google|linkedin|twitter campaigns. OG image/url/type and twitter:image
// stay constant across variants — the page's only on-site hero-grade asset is the logo and canonical stays /ffmg-express.
router.get('/ffmg-express', (req, res) => {
  const gaId = process.env.GA4_MEASUREMENT_ID || '';
  const htmlPath = path.join(__dirname, '..', 'public', 'ffmg-express', 'landing.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__GA4_ID__', gaId);

    const source = String(req.query.utm_source || '').toLowerCase().trim();
    const variants = {
      google: {
        ogTitle: 'Custom websites. Delivered in 7 days. | Funk Factory Media Group',
        ogDesc: "You searched, we showed up — here's the flat-rate menu. Three tiers, one transparent price each. No retainers, no agency markup, no surprises."
      },
      linkedin: {
        ogTitle: 'Custom sites delivered in 7 days. | Funk Factory Media Group',
        ogDesc: "You came in from LinkedIn — here's the flat-rate pricing our audience has been asking about. Pick a tier, send the intake, ship by next week."
      },
      twitter: {
        ogTitle: 'Flat-rate custom websites. Shipped fast. | Funk Factory Media Group',
        ogDesc: "Found us on X? Here's the abbreviated menu: pricing tiers, timelines, intake. No retainers, no surprises — same deal every client gets."
      }
    };
    const variant = variants[source];
    if (variant) {
      const currentOgTitle = 'Custom websites delivered in 7 days. | Funk Factory Media Group';
      const currentOgDesc = 'Three transparent tiers. One flat price each. No retainers, no agency markup, no surprises — pick the build that fits and ship a custom site in under two weeks.';
      html = html
        .replace('content="' + currentOgTitle + '"', 'content="' + variant.ogTitle + '"')
        .replace('content="' + currentOgDesc + '"', 'content="' + variant.ogDesc + '"')
        .replace('content="' + currentOgTitle + '"', 'content="' + variant.ogTitle + '"')
        .replace('content="' + currentOgDesc + '"', 'content="' + variant.ogDesc + '"');
    }

    res.type('html').send(html);
  } else {
    res.redirect('/');
  }
});

// GET /what-we-offer — web services pricing page
router.get('/what-we-offer', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'what-we-offer.html'));
});

// GET /intake — client intake form
router.get('/intake', (req, res) => {
  const htmlPath = path.join(__dirname, '..', 'public', 'intake.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect('/what-we-offer');
  }
});

// GET /services — media services page with analytics slug injection
router.get('/services', (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, '..', 'public', 'services.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.redirect('/');
  }
});

// GET / — FFMG homepage with analytics slug injection + top-3 case-study tiles.
// Pulls the 3 most recent case_studies rows and server-renders them into the
// Featured Work section. A DB hiccup degrades silently to an empty rail rather
// than 500ing the homepage (which would block every visitor). Existing fallback
// path (json when index.html is missing) is preserved.
router.get('/', async (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');

    let tilesHtml = '';
    try {
      const db = require('../db/case-studies');
      const rows = await db.listRecentCaseStudies(3);
      if (rows.length === 0) {
        tilesHtml = '<div class="case-card-empty">No case studies yet — check back soon.</div>';
      } else {
        tilesHtml = rows.map(renderCaseStudyTile).join('\n');
      }
    } catch (err) {
      console.error('[home] case studies render error:', err.message);
    }

    html = html
      .replace('__POLSIA_SLUG__', slug)
      .replace('__CANONICAL__', escapeHtml(getCanonicalUrl('/')))
      .replace('__FEATURED_TILES__', tilesHtml);
    res.type('html').send(html);
  } else {
    res.json({ message: 'Hello from Polsia Instance!' });
  }
});

module.exports = router;

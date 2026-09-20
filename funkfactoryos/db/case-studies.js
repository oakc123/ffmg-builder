// Owns: case_studies table queries for the /work portfolio hub, tile grid,
// and /work/:slug detail page.
// Does NOT own: pool construction (db/index.js), seed inserts (migrations/).
const pool = require('./index');

async function listCaseStudies() {
  const { rows } = await pool.query(
    `SELECT slug, title, client, service_tags, cover_image_url, summary
       FROM case_studies
      ORDER BY display_order ASC, id ASC`
  );
  return rows;
}

async function getFeaturedCaseStudy() {
  const { rows } = await pool.query(
    `SELECT slug, title, client, service_tags, cover_image_url, summary
       FROM case_studies
      ORDER BY created_at ASC, id ASC
      LIMIT 1`
  );
  return rows[0] || null;
}

// Single-row fetch for /work/:slug + the /api/work/case-studies/:slug API.
// narrative is JSONB so node-pg returns it already-parsed ({challenge,...}).
async function getCaseStudyBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT slug, title, client, service_tags, cover_image_url, summary, narrative
       FROM case_studies
      WHERE slug = $1`,
    [slug]
  );
  return rows[0] || null;
}

// Slim row shape for /sitemap.xml — slug + created_at only, so we don't
// pull narrative JSONB for every row on every sitemap request.
async function listCaseStudiesForSitemap() {
  const { rows } = await pool.query(
    `SELECT slug, created_at FROM case_studies ORDER BY display_order ASC, id ASC`
  );
  return rows;
}

// Slim payload for the homepage "recent work" rail — N most recently
// created case studies by created_at DESC. Parameterised LIMIT keeps this
// reusable for any other "latest" surface in the future. Returns the same
// column set as listCaseStudies() so the tile renderer can be shared with /work.
async function listRecentCaseStudies(limit) {
  const { rows } = await pool.query(
    `SELECT slug, title, client, service_tags, cover_image_url, summary
       FROM case_studies
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { listCaseStudies, getFeaturedCaseStudy, getCaseStudyBySlug, listCaseStudiesForSitemap, listRecentCaseStudies };

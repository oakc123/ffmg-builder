// Owns: /api/work API endpoints — read-only portfolio hub data for /work.
// Does NOT own: page rendering (public/work.html), pool construction.
const express = require('express');
const router = express.Router();
const db = require('../db/case-studies');

// GET /api/work/case-studies — tile payload for the /work hub page.
// Returns an envelope (`{ case_studies: [...] }`) to match the list shape
// used by other API endpoints in this codebase rather than a bare array.
router.get('/case-studies', async (req, res) => {
  try {
    const [featured_case_study, case_studies] = await Promise.all([
      db.getFeaturedCaseStudy(),
      db.listCaseStudies()
    ]);
    res.json({ featured_case_study, case_studies });
  } catch (err) {
    console.error('[case-studies] list error:', err.message);
    res.status(500).json({ error: 'Could not load case studies' });
  }
});

// GET /api/work/case-studies/:slug — single-row detail payload for /work/:slug.
// Same `{ case_study: ... }` envelope shape so detail consumers parse the same
// way they parse the list response.
router.get('/case-studies/:slug', async (req, res) => {
  const slug = req.params.slug || '';
  if (!/^[a-z0-9-]+$/i.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug' });
  }
  try {
    const case_study = await db.getCaseStudyBySlug(slug);
    if (!case_study) return res.status(404).json({ error: 'Not found' });
    res.json({ case_study });
  } catch (err) {
    console.error('[case-studies] detail error:', err.message);
    res.status(500).json({ error: 'Could not load case study' });
  }
});

module.exports = router;

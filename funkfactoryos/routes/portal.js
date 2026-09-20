// Owns: portal data endpoints (GET /api/portal/progress)
// Does NOT own: auth logic (routes/auth.js), messages (routes/messages.js)
const express = require('express');
const router = express.Router();
const { requirePortalAuth } = require('./auth');
const { findCustomerByUUID, getProjectProgress } = require('../db/customers');

// GET /api/portal/progress
// Returns project progress entries + customer info for the dashboard
router.get('/progress', requirePortalAuth, async (req, res) => {
  const { customer_uuid } = req.portal;

  try {
    const [customer, progress] = await Promise.all([
      findCustomerByUUID(customer_uuid),
      getProjectProgress(customer_uuid)
    ]);

    res.json({
      customer_uuid,
      job_id: req.portal.job_id,
      projectStatus: customer ? customer.project_status : null,
      businessName: customer ? customer.business_name : null,
      packageTier: customer ? customer.package_tier : null,
      progress: progress.map(p => ({
        id: p.id,
        url: p.url,
        note: p.note,
        created_at: p.created_at
      })),
      // Preview delivery data — populated when homelab sends POST /api/preview
      preview: customer && customer.preview_url ? {
        url: customer.preview_url,
        expires_at: customer.preview_expires_at,
        package: customer.preview_package,
        pages_built: customer.preview_pages_built,
        built_at: customer.preview_built_at,
        notes: customer.preview_notes
      } : null
    });
  } catch (err) {
    console.error('[Portal] Progress fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load project data' });
  }
});

module.exports = router;

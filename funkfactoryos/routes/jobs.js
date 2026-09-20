// Owns: homelab intake jobs proxy — GET /api/jobs (list), GET /api/jobs/latest (most recent), GET /api/jobs/:jobId (single)
// Does NOT own: admin portal job management (admin-portal.js), intake form submission (intake.js)
'use strict';

const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const INTAKE_BASE = 'https://intake.funkfactorymediagroup.com';
const INTAKE_SECRET = process.env.INTAKE_WEBHOOK_SECRET || 'ffmg-intake-2026';
const ALERT_EMAIL = process.env.AMER_ALERT_EMAIL || 'amer.child@funkfactorymediagroup.com';

// In-memory last seen job_id — reset on server restart (acceptable for this use case)
// In production, this would be stored in Redis or the DB for persistence across restarts.
let lastSeenJobId = null;

// ── FETCH HELPERS ───────────────────────────────────────────────────────────

async function fetchFromIntake(path) {
  try {
    const res = await fetch(`${INTAKE_BASE}${path}`, {
      headers: { 'X-Polsia-Secret': INTAKE_SECRET },
      timeout: 10000
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json();
    return { ok: true, data: body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── EMAIL ALERT ─────────────────────────────────────────────────────────────

async function alertAmerOfNewJob(job) {
  const apiKey = process.env.POLSIA_API_KEY;
  if (!apiKey) {
    console.warn('[Jobs] POLSIA_API_KEY not set — cannot send email alert');
    return;
  }

  const company = job.contact?.business_name || job.business_name || job.company_name || 'Unknown';
  const contact = job.contact?.full_name || job.full_name || '';
  const projectType = job.project?.goal || job.description || job.package || 'Web Design';
  const email = job.contact?.email || job.email || '';
  const jobId = job.job_id || job.id || '';

  const subject = `New Job Alert: ${company}`;
  const body = [
    `A new intake job arrived from the homelab.`,
    ``,
    `Company: ${company}`,
    contact ? `Contact: ${contact}` : null,
    email ? `Email: ${email}` : null,
    `Project: ${projectType}`,
    jobId ? `Job ID: ${jobId}` : null,
    ``,
    `View job: https://funkfactoryos.polsia.app/admin/jobs/${encodeURIComponent(jobId)}`
  ].filter(Boolean).join('\n');

  try {
    await fetch('https://polsia.com/api/proxy/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ to: ALERT_EMAIL, subject, body })
    });
    console.log(`[Jobs] Email alert sent to ${ALERT_EMAIL} for job ${jobId}`);
  } catch (err) {
    console.error('[Jobs] Email alert failed:', err.message);
  }
}

// ── ROUTES ─────────────────────────────────────────────────────────────────

// GET /api/jobs — proxy to homelab jobs index
router.get('/', async (req, res) => {
  const result = await fetchFromIntake('/jobs/index.jsonl');
  if (!result.ok) {
    return res.status(502).json({
      success: false,
      error: 'Failed to reach homelab intake service',
      detail: result.error || `HTTP ${result.status}`
    });
  }
  res.json({ success: true, jobs: result.data, source: 'homelab' });
});

// GET /api/jobs/:jobId — return a specific job by job_id
router.get('/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const result = await fetchFromIntake('/jobs/index.jsonl');
  if (!result.ok) {
    return res.status(502).json({
      success: false,
      error: 'Failed to reach homelab intake service',
      detail: result.error || `HTTP ${result.status}`
    });
  }
  const job = (result.data || []).find(j =>
    String(j.job_id || j.id) === jobId
  );
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, job, source: 'homelab' });
});

// GET /api/jobs/latest — return most recent job, alert on new arrival
router.get('/latest', async (req, res) => {
  const result = await fetchFromIntake('/jobs/index.jsonl');
  if (!result.ok) {
    return res.status(502).json({
      success: false,
      error: 'Failed to reach homelab intake service',
      detail: result.error || `HTTP ${result.status}`
    });
  }

  const jobs = result.data;
  if (!jobs || jobs.length === 0) {
    return res.json({ success: true, job: null, is_new: false, total: 0 });
  }

  // Sort by submitted_at desc, fall back to job_id string sort
  const sorted = [...jobs].sort((a, b) => {
    const ta = a.submitted_at || a.created_at || '';
    const tb = b.submitted_at || b.created_at || '';
    if (ta && tb) return new Date(tb) - new Date(ta);
    return String(b.job_id || b.id || '').localeCompare(String(a.job_id || a.id || ''));
  });

  const latest = sorted[0];
  const latestId = latest.job_id || latest.id || null;
  const isNew = lastSeenJobId !== null && latestId !== null && latestId !== lastSeenJobId;

  if (isNew) {
    // New job detected — alert Amer, then update lastSeenJobId
    console.log(`[Jobs] New job detected: ${latestId} (was: ${lastSeenJobId})`);
    alertAmerOfNewJob(latest).catch(err => console.error('[Jobs] Alert error:', err.message));
  }

  lastSeenJobId = latestId;

  res.json({
    success: true,
    job: latest,
    is_new: isNew,
    total: jobs.length,
    last_seen_id: lastSeenJobId
  });
});

module.exports = router;
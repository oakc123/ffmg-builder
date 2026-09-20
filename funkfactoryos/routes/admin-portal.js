// Owns: JWT admin portal auth, notifications, dashboard API, jobs API (list + detail + mutations), agent-reply messages, email notifications
// Does NOT own: legacy cookie auth (routes/admin.js), gallery/gigs/orders/analytics admin routes, customer-facing portal auth
'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('../db/admin');
const dbAdminUsers = require('../db/admin-users');
const dbMessages = require('../db/messages');
const { getIntakeSubmissions, updateIntakeSubmissionStatus } = require('../db/intake-submissions');

// ── CONFIG ─────────────────────────────────────────────────────────────────────
const INTAKE_BASE = 'https://intake.funkfactorymediagroup.com';
const INTAKE_SECRET = process.env.INTAKE_WEBHOOK_SECRET || 'ffmg-intake-2026';
const ASSISTANT_BASE = process.env.ASSISTANT_BASE_URL || 'https://builder.funkfactorymediagroup.com';

// ── JWT HELPERS (manual HMAC-SHA256, no external dep) ─────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJwt(payload) {
  const secret = process.env.ADMIN_JWT_SECRET || 'ffmg-jwt-dev-secret-change-in-prod';
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(
    crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token) {
  try {
    const secret = process.env.ADMIN_JWT_SECRET || 'ffmg-jwt-dev-secret-change-in-prod';
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expectedSig = b64url(
      crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest()
    );
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── RATE LIMIT (in-memory, per IP, 5 attempts / 15 min) ───────────────────────
const loginAttempts = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const window = 15 * 60 * 1000;
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + window };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + window; }
  if (entry.count >= 5) return false;
  entry.count += 1;
  loginAttempts.set(ip, entry);
  return true;
}

function clearRateLimit(ip) { loginAttempts.delete(ip); }

// ── FORGOT PASSWORD RATE LIMIT (3 per email / hour) ───────────────────────────
const forgotAttempts = new Map();

function checkForgotRateLimit(email) {
  const key = email.toLowerCase();
  const now = Date.now();
  const window = 60 * 60 * 1000;
  const entry = forgotAttempts.get(key) || { count: 0, resetAt: now + window };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + window; }
  if (entry.count >= 3) return false;
  entry.count += 1;
  forgotAttempts.set(key, entry);
  return true;
}

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
function requireAdminJwt(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const token = auth.slice(7);
  const payload = verifyJwt(token);
  if (!payload || payload.role !== 'admin') return res.status(401).json({ success: false, message: 'Unauthorized' });
  req.adminPayload = payload;
  next();
}

// ── INTAKE SERVICE HELPERS ─────────────────────────────────────────────────────

// Fetch full job detail from intake service
async function fetchJobFromIntake(jobId) {
  try {
    const res = await fetch(`${INTAKE_BASE}/jobs/${encodeURIComponent(jobId)}.json`, {
      headers: { 'X-Polsia-Secret': INTAKE_SECRET },
      timeout: 8000
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Fetch jobs index from intake service
async function fetchJobsIndexFromIntake() {
  try {
    const res = await fetch(`${INTAKE_BASE}/jobs/index.jsonl`, {
      headers: { 'X-Polsia-Secret': INTAKE_SECRET },
      timeout: 10000
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return null;
  }
}

// Patch job data back to intake service
async function patchJobAtIntake(jobId, patch) {
  try {
    const res = await fetch(`${INTAKE_BASE}/jobs/${encodeURIComponent(jobId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Polsia-Secret': INTAKE_SECRET
      },
      body: JSON.stringify(patch),
      timeout: 8000
    });
    if (!res.ok) return { ok: false, error: `Status ${res.status}` };
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── POST /api/admin/auth ───────────────────────────────────────────────────────
router.post('/auth', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ success: false, message: 'Too many attempts. Try again in 15 minutes.' });
  const { password } = req.body;
  if (!password) return res.status(400).json({ success: false, message: 'Password required' });

  // Try admin_users table first
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@funkfactorymediagroup.com';
  const adminUser = await dbAdminUsers.findAdminUserByEmail(adminEmail).catch(() => null);

  let match = false;
  if (adminUser) {
    match = dbAdminUsers.verifyPassword(password, adminUser.password_hash);
    if (match) {
      clearRateLimit(ip);
      const exp = Math.floor(Date.now() / 1000) + 8 * 3600;
      const token = makeJwt({ role: 'admin', adminId: adminUser.id, exp });
      const expires_at = new Date(exp * 1000).toISOString();
      return res.json({ success: true, token, expires_at });
    }
  }

  // Fall back to env var (backward compat during migration)
  const adminPassword = process.env.ADMIN_PASSWORD || 'ffmg2026';
  const submitted = Buffer.from(password);
  const expected = Buffer.from(adminPassword);
  match = submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected);
  if (!match) return res.status(401).json({ success: false, message: 'Incorrect password' });

  clearRateLimit(ip);
  const exp = Math.floor(Date.now() / 1000) + 8 * 3600;
  const token = makeJwt({ role: 'admin', exp });
  const expires_at = new Date(exp * 1000).toISOString();
  res.json({ success: true, token, expires_at });
});

// ── GET /api/admin/notifications ──────────────────────────────────────────────
router.get('/notifications', requireAdminJwt, async (req, res) => {
  try {
    await syncNotificationsFromDB();
    const notifications = await db.getNotifications();
    const unread_count = notifications.filter(n => !n.read).length;
    res.json({ success: true, notifications, unread_count });
  } catch (err) {
    console.error('[AdminPortal] notifications error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/intake ─────────────────────────────────────────────────────
router.get('/intake', requireAdminJwt, async (req, res) => {
  try {
    const submissions = await getIntakeSubmissions();
    res.json({ success: true, submissions });
  } catch (err) {
    console.error('[AdminPortal] intake error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PATCH /api/admin/intake/:id/status ───────────────────────────────────────
router.patch('/intake/:id/status', requireAdminJwt, async (req, res) => {
  try {
    const { status } = req.body || {};
    const validStatuses = ['new', 'contacted', 'qualified', 'closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const submission = await updateIntakeSubmissionStatus(req.params.id, status);
    if (!submission) return res.status(404).json({ success: false, message: 'Submission not found' });
    res.json({ success: true, status: submission.status });
  } catch (err) {
    console.error('[AdminPortal] intake status update error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/intake/export ────────────────────────────────────────────
router.get('/intake/export', requireAdminJwt, async (req, res) => {
  try {
    const submissions = await getIntakeSubmissions();
    const headers = ['client_name', 'company', 'project_type', 'budget', 'timeline', 'brief', 'created_at'];
    const escapeCsv = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    const rows = submissions.map((submission) => [
      submission.name,
      submission.business_name,
      submission.package,
      submission.budget_confirm,
      submission.timeline,
      submission.description,
      submission.created_at == null ? null : new Date(submission.created_at).toISOString()
    ].map(escapeCsv).join(','));

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="intake-submissions.csv"'
    });
    res.send(`${headers.join(',')}\r\n${rows.join('\r\n')}${rows.length ? '\r\n' : ''}`);
  } catch (err) {
    console.error('[AdminPortal] intake export error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/notifications/read ────────────────────────────────────────
router.post('/notifications/read', requireAdminJwt, async (req, res) => {
  try {
    const { all, notification_id } = req.body;
    await db.markNotificationsRead({ all, notification_id });
    res.json({ success: true });
  } catch (err) {
    console.error('[AdminPortal] notifications read error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/dashboard ──────────────────────────────────────────────────
router.get('/dashboard', requireAdminJwt, async (req, res) => {
  try {
    const [stats, activity, pendingJobs, leadSources] = await Promise.all([
      db.getDashboardStats(),
      db.getRecentActivity(),
      db.getPendingApprovalJobs(),
      db.getLeadSourceStats()
    ]);
    res.json({ success: true, stats, activity, pending_jobs: pendingJobs, lead_sources: leadSources });
  } catch (err) {
    console.error('[AdminPortal] dashboard error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/cta-stats ──────────────────────────────────────────────────
// Hero CTA A/B test results — submissions per variant over last 14 days
router.get('/cta-stats', requireAdminJwt, async (req, res) => {
  try {
    const rows = await db.getCtaVariantStats();
    const map = { A: 0, B: 0, untracked: 0 };
    for (const row of rows) {
      map[row.variant] = row.submissions;
    }
    const totalTracked = map.A + map.B;
    const winner = totalTracked > 0 ? (map.A > map.B ? 'A' : map.A < map.B ? 'B' : null) : null;
    res.json({
      success: true,
      variant_a: map.A,
      variant_b: map.B,
      untracked: map.untracked,
      total_tracked: totalTracked,
      winner
    });
  } catch (err) {
    console.error('[AdminPortal] cta-stats error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/jobs ───────────────────────────────────────────────────────
router.get('/jobs', requireAdminJwt, async (req, res) => {
  try {
    const { status, package: pkg, search } = req.query;

    // Try intake service first, fall back to DB
    const intakeJobs = await fetchJobsIndexFromIntake();

    if (intakeJobs && intakeJobs.length > 0) {
      let jobs = intakeJobs;
      if (status && status !== 'all') jobs = jobs.filter(j => j.status === status || j.project_status === status);
      if (pkg && pkg !== 'all') jobs = jobs.filter(j => (j.package || j.package_tier || '').toLowerCase() === pkg.toLowerCase());
      if (search) {
        const q = search.toLowerCase();
        jobs = jobs.filter(j =>
          (j.business_name || j.name || '').toLowerCase().includes(q) ||
          (j.job_id || '').toLowerCase().includes(q)
        );
      }
      return res.json({ success: true, jobs, source: 'intake' });
    }

    // Fall back to customers DB
    const jobs = await db.getAllJobs({ status: status && status !== 'all' ? status : undefined });
    let filtered = jobs;
    if (pkg && pkg !== 'all') filtered = filtered.filter(j => (j.package_tier || '').toLowerCase() === pkg.toLowerCase());
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(j =>
        (j.business_name || j.name || '').toLowerCase().includes(q) ||
        (j.job_id || '').toLowerCase().includes(q)
      );
    }
    res.json({ success: true, jobs: filtered, source: 'db' });
  } catch (err) {
    console.error('[AdminPortal] jobs error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/jobs/:job_id ───────────────────────────────────────────────
router.get('/jobs/:job_id', requireAdminJwt, async (req, res) => {
  try {
    const jobId = req.params.job_id;

    // Try intake service first
    const intakeJob = await fetchJobFromIntake(jobId);
    if (intakeJob) return res.json({ success: true, job: intakeJob, source: 'intake' });

    // Fall back to DB
    const job = await db.getJobByJobId(jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    res.json({ success: true, job, source: 'db' });
  } catch (err) {
    console.error('[AdminPortal] job detail error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PATCH /api/admin/jobs/:job_id/tasks ──────────────────────────────────────
router.patch('/jobs/:job_id/tasks', requireAdminJwt, async (req, res) => {
  try {
    const jobId = req.params.job_id;
    const { task_number, status, rejection_reason } = req.body;
    if (!task_number || !status) return res.status(400).json({ success: false, message: 'task_number and status required' });
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ success: false, message: 'status must be approved or rejected' });

    // Try intake service patch
    const patch = { task_update: { task_number, status, rejection_reason: rejection_reason || null, updated_at: new Date().toISOString() } };
    const result = await patchJobAtIntake(jobId, patch);

    if (result.ok) return res.json({ success: true, job: result.data });

    // Intake service unavailable — store in DB overlay
    await db.upsertJobOverlay(jobId, { [`task_${task_number}_status`]: status, [`task_${task_number}_rejection`]: rejection_reason || null });
    res.json({ success: true, stored: 'db_overlay', message: 'Intake service unavailable; stored locally' });
  } catch (err) {
    console.error('[AdminPortal] task update error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PATCH /api/admin/jobs/:job_id/package ────────────────────────────────────
router.patch('/jobs/:job_id/package', requireAdminJwt, async (req, res) => {
  try {
    const jobId = req.params.job_id;
    const { package: pkg } = req.body;
    if (!['standard', 'premium'].includes(pkg)) return res.status(400).json({ success: false, message: 'package must be standard or premium' });

    const result = await patchJobAtIntake(jobId, { package: pkg });
    if (result.ok) return res.json({ success: true, job: result.data });

    // Fall back: update local customers table
    const updated = await db.updateJobPackage(jobId, pkg);
    res.json({ success: true, job: updated });
  } catch (err) {
    console.error('[AdminPortal] package update error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/jobs/:job_id/flag ────────────────────────────────────────
router.post('/jobs/:job_id/flag', requireAdminJwt, async (req, res) => {
  try {
    const jobId = req.params.job_id;
    const { reason } = req.body;

    const patch = { status: 'flagged', flag_reason: reason || null, flagged_at: new Date().toISOString() };
    const result = await patchJobAtIntake(jobId, patch);
    if (result.ok) return res.json({ success: true, job: result.data });

    // Fall back: update DB
    const updated = await db.flagJob(jobId, reason);
    res.json({ success: true, job: updated });
  } catch (err) {
    console.error('[AdminPortal] flag error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/jobs/:job_id/unflag ──────────────────────────────────────
router.post('/jobs/:job_id/unflag', requireAdminJwt, async (req, res) => {
  try {
    const jobId = req.params.job_id;

    const patch = { unflag: true };
    const result = await patchJobAtIntake(jobId, patch);
    if (result.ok) return res.json({ success: true, job: result.data });

    // Fall back: update DB
    const updated = await db.unflagJob(jobId);
    res.json({ success: true, job: updated });
  } catch (err) {
    console.error('[AdminPortal] unflag error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/jobs/:job_id/trigger-build ───────────────────────────────
router.post('/jobs/:job_id/trigger-build', requireAdminJwt, async (req, res) => {
  try {
    const jobId = req.params.job_id;
    const { force_claude } = req.body;
    const assistantKey = process.env.ASSISTANT_API_KEY;

    if (!assistantKey) {
      return res.status(503).json({ success: false, message: 'ASSISTANT_API_KEY not configured' });
    }

    const assistantRes = await fetch(`${ASSISTANT_BASE}/build/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${assistantKey}`
      },
      body: JSON.stringify({ job_id: jobId, force_claude: !!force_claude }),
      timeout: 30000
    });

    const data = await assistantRes.json().catch(() => ({ success: false, message: 'Invalid response from assistant' }));
    res.status(assistantRes.status).json(data);
  } catch (err) {
    console.error('[AdminPortal] trigger-build error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/admin/jobs/:job_id/status (legacy kept for compatibility) ──────
const VALID_STATUSES = ['intake_received', 'pending_approval', 'approved', 'in_development', 'preview_ready', 'changes_requested', 'delivered', 'flagged'];
router.patch('/jobs/:job_id/status', requireAdminJwt, async (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
    const job = await db.updateJobStatus(req.params.job_id, status);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    res.json({ success: true, job });
  } catch (err) {
    console.error('[AdminPortal] job status update error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Sync helper delegated to db/admin.js (owns all DB queries)
const syncNotificationsFromDB = () => db.syncNotificationsFromDB();

// ── EMAIL NOTIFICATION HELPER ─────────────────────────────────────────────────
// Sends admin notification emails via Polsia email proxy (fire-and-forget)
async function sendAdminEmail({ subject, body, jobId }) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return; // Not configured — skip silently
  const apiKey = process.env.POLSIA_API_KEY;
  if (!apiKey) return;

  const appUrl = 'https://funkfactoryos.polsia.app';
  const jobLink = jobId ? `\n\nView job: ${appUrl}/admin/jobs/${encodeURIComponent(jobId)}` : '';

  try {
    await fetch('https://polsia.com/api/proxy/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ to: adminEmail, subject, body: body + jobLink })
    });
  } catch (err) {
    console.error('[AdminEmail] send error:', err.message);
  }
}

// Exported so other modules can trigger notifications (e.g. intake webhook)
async function notifyAdmin(type, { businessName, jobId } = {}) {
  const subjects = {
    new_job: `New project request: ${businessName}`,
    customer_message: `${businessName} sent you a message`,
    preview_approved: `${businessName} approved — ready to package`,
    changes_requested: `${businessName} requested changes`,
    build_complete: `Build complete: ${businessName} — preview ready`
  };
  const subject = subjects[type] || `FFMG Admin notification`;
  const body = `${subject}\n\nJob ID: ${jobId || 'unknown'}`;
  await sendAdminEmail({ subject, body, jobId });
}

// ── FORGOT PASSWORD ───────────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') return res.status(400).json({ success: false, message: 'Email required' });

  // Rate limit per email (3 per hour)
  if (!checkForgotRateLimit(email)) {
    return res.status(429).json({ success: false, message: 'Too many reset requests. Try again in an hour.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Find user (silently do nothing if no match — don't reveal whether account exists)
  const user = await dbAdminUsers.findAdminUserByEmail(normalizedEmail).catch(() => null);
  if (!user) {
    // Sleep briefly to prevent timing-based user enumeration
    await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
    return res.json({ success: true, sent: true }); // Always show success
  }

  // Set reset token
  const result = await dbAdminUsers.setResetToken(normalizedEmail).catch(() => null);
  if (!result) {
    return res.status(500).json({ success: false, message: 'Failed to generate reset link. Please try again.' });
  }

  const { token } = result;
  const resetUrl = `https://funkfactoryos.polsia.app/admin/reset-password?token=${token}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: 'DM Sans', Arial, sans-serif; background: #faf6f1; margin: 0; padding: 40px 20px;">
      <div style="max-width: 520px; margin: 0 auto; background: #fff; border-radius: 12px; border: 1px solid rgba(107,58,31,0.12); padding: 40px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <svg width="40" height="40" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="6" fill="#6B3A1F"/>
            <text x="8" y="24" font-family="Arial Black,Arial" font-weight="900" font-size="22" fill="#D4956A">F</text>
          </svg>
        </div>
        <h1 style="color: #1a0f08; font-size: 22px; font-weight: 700; margin: 0 0 8px; text-align: center;">Reset your FFMG Admin password</h1>
        <p style="color: #6b5c50; font-size: 15px; line-height: 1.6; margin: 0 0 28px; text-align: center;">
          We received a request to reset the password for your FFMG Admin account. Click the button below to set a new password. This link expires in 1 hour.
        </p>
        <div style="text-align: center; margin-bottom: 28px;">
          <a href="${resetUrl}" style="display: inline-block; background: #D4956A; color: #fff; text-decoration: none; font-weight: 600; font-size: 16px; padding: 14px 32px; border-radius: 8px;">
            Reset Password →
          </a>
        </div>
        <p style="color: #6b5c50; font-size: 13px; text-align: center; margin: 0;">
          If you didn't request this, you can safely ignore this email.<br>
          This link expires in 1 hour and can only be used once.
        </p>
        <div style="margin-top: 28px; padding-top: 20px; border-top: 1px solid rgba(107,58,31,0.1); text-align: center;">
          <p style="color: #9b8a7e; font-size: 12px; margin: 0;">
            Funk Factory Media Group · Albuquerque, NM
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    const apiKey = process.env.POLSIA_API_KEY;
    if (apiKey) {
      await fetch('https://polsia.com/api/proxy/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          to: normalizedEmail,
          subject: 'FFMG Admin — Password Reset',
          body: `Reset your FFMG Admin password: ${resetUrl}\n\nThis link expires in 1 hour.`,
          html
        })
      });
    }
  } catch (err) {
    console.error('[AdminPortal] forgot-password email error:', err.message);
    // Still return success — we don't want to reveal email send failures
  }

  res.json({ success: true, sent: true });
});

// ── RESET PASSWORD ───────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ success: false, message: 'Token and new password are required' });
  }

  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  }

  const result = await dbAdminUsers.updatePasswordByToken(token, password).catch(() => null);

  if (!result) {
    return res.status(400).json({ success: false, message: 'This link is invalid or has expired. Please request a new one.' });
  }

  res.json({ success: true });
});

// ── GET /api/admin/messages ───────────────────────────────────────────────────
// Returns all jobs that have messages, with unread counts — for left panel
router.get('/messages', requireAdminJwt, async (req, res) => {
  try {
    const jobs = await dbMessages.getJobsWithMessages();
    res.json({ success: true, jobs });
  } catch (err) {
    console.error('[AdminPortal] messages list error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/messages/:job_id ──────────────────────────────────────────
// Returns full thread for a job, marks customer messages as read
router.get('/messages/:job_id', requireAdminJwt, async (req, res) => {
  try {
    const jobId = req.params.job_id;
    const messages = await dbMessages.getMessagesByJobId(jobId);
    // Mark customer messages as read since admin is viewing the thread
    dbMessages.markCustomerMessagesRead(jobId).catch(() => {});
    res.json({ success: true, messages });
  } catch (err) {
    console.error('[AdminPortal] messages thread error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/messages/agent-reply ─────────────────────────────────────
// Admin sends a reply to a customer message thread
router.post('/messages/agent-reply', requireAdminJwt, async (req, res) => {
  try {
    const { job_id, body, sent_at } = req.body;
    if (!job_id || typeof job_id !== 'string') return res.status(400).json({ success: false, message: 'job_id required' });
    if (!body || typeof body !== 'string' || !body.trim()) return res.status(400).json({ success: false, message: 'body required' });
    if (body.length > 2000) return res.status(400).json({ success: false, message: 'Message too long (2000 char max)' });

    const msg = await dbMessages.insertMessage({
      jobId: job_id,
      customerUuid: null, // agent messages don't require a customer_uuid
      from: 'agent',
      body: body.trim(),
      sentAt: sent_at || null
    });

    // Notify customer via email (fire-and-forget)
    const customer = await dbMessages.getCustomerEmailByJobId(job_id).catch(() => null);
    if (customer && customer.email) {
      const apiKey = process.env.POLSIA_API_KEY;
      if (apiKey) {
        fetch('https://polsia.com/api/proxy/email/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            to: customer.email,
            subject: 'New message from Funk Factory Media Group',
            body: `Hi ${customer.name || 'there'},\n\nYou have a new message from the FFMG team.\n\n---\n${body.trim()}\n---\n\nReply by visiting your project portal:\nhttps://funkfactoryos.polsia.app/portal`,
            html: `<p>Hi ${customer.name || 'there'},</p><p>You have a new message from the FFMG team.</p><blockquote style="border-left:3px solid #D4956A;padding-left:12px;color:#555">${body.trim().replace(/\n/g, '<br>')}</blockquote><p><a href="https://funkfactoryos.polsia.app/portal" style="color:#D4956A">View your project portal →</a></p>`
          })
        }).catch(err => console.error('[AdminPortal] customer email error:', err.message));
      }
    }

    res.json({ success: true, message: msg });
  } catch (err) {
    console.error('[AdminPortal] agent-reply error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/costs ──────────────────────────────────────────────────────
// Proxies cost data from the FFMG assistant service
router.get('/costs', requireAdminJwt, async (req, res) => {
  try {
    const assistantKey = process.env.ASSISTANT_API_KEY;
    if (!assistantKey) {
      return res.status(503).json({ success: false, message: 'ASSISTANT_API_KEY not configured' });
    }

    const { page = '1', per_page = '20', sort = 'date_desc' } = req.query;

    const costRes = await fetch(`${ASSISTANT_BASE}/costs/summary`, {
      headers: { Authorization: `Bearer ${assistantKey}` },
      timeout: 10000
    });

    if (!costRes.ok) {
      return res.status(costRes.status).json({ success: false, message: `Assistant service error: ${costRes.status}` });
    }

    const data = await costRes.json();
    res.json({ success: true, ...data, page: parseInt(page), per_page: parseInt(per_page), sort });
  } catch (err) {
    console.error('[AdminPortal] costs error:', err.message);
    res.status(503).json({ success: false, message: 'Cost data unavailable — ensure the builder service is running at https://builder.funkfactorymediagroup.com' });
  }
});

// ── GET /api/admin/ffmg-express-attribution ──────────────────────────────────
// FFMG Express conversion attribution dashboard — sessions, contact / intake
// funnel steps, and top campaigns by pipeline value.
router.get('/ffmg-express-attribution', requireAdminJwt, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));
    const [overall, sessions, contacts, intakes, top, express_variants, social_proof, pricing_variants] = await Promise.all([
      db.getOverallTotals({ days }),
      db.getSessionsBySource({ days }),
      db.getContactConversionsBySource({ days }),
      db.getIntakeCompletionsBySource({ days }),
      db.getTopCampaignsByROI({ days: 30, limit: 5 }),
      db.getExpressCtaVariantStats({ days }),
      db.getSocialProofPlacements({ days }),
      db.getPricingVariantSourceAttribution({ days })
    ]);

    let rebaseline;
    try {
      rebaseline = await db.getRebaselineLiftSummary();
    } catch (summaryErr) {
      console.error('[AdminPortal] ffmg-express rebaseline summary error:', summaryErr.message);
      rebaseline = {
        status: 'error',
        available: false,
        message: 'Re-baseline summary could not be loaded.'
      };
    }

    res.json({ success: true, days, overall, sessions, contacts, intakes, top, express_variants, social_proof, pricing_variants, rebaseline });
  } catch (err) {
    console.error('[AdminPortal] ffmg-express-attribution error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
module.exports.notifyAdmin = notifyAdmin;

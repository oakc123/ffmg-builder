// Owns: admin_notifications queries, admin dashboard aggregate queries
// Does NOT own: pool construction (db/index.js), customer/message data (db/customers.js, db/messages.js)
const pool = require('./index');

// ── NOTIFICATIONS ──────────────────────────────────────────────────────────────

// Get recent notifications (aggregated across customers table + messages + manual entries)
// Returns up to 50, unread first then by recency
async function getNotifications() {
  const { rows } = await pool.query(`
    SELECT notification_id, type, job_id, business_name, message, read, created_at
    FROM admin_notifications
    ORDER BY read ASC, created_at DESC
    LIMIT 50
  `);
  return rows;
}

// Count unread notifications
async function getUnreadCount() {
  const { rows } = await pool.query(`SELECT COUNT(*) as count FROM admin_notifications WHERE read = FALSE`);
  return parseInt(rows[0].count);
}

// Mark all or one notification as read
async function markNotificationsRead({ all, notification_id }) {
  if (all) {
    await pool.query(`UPDATE admin_notifications SET read = TRUE WHERE read = FALSE`);
  } else if (notification_id) {
    await pool.query(`UPDATE admin_notifications SET read = TRUE WHERE notification_id = $1`, [notification_id]);
  }
}

// Insert a notification (called when new jobs/messages arrive)
async function createNotification({ type, job_id, business_name, message }) {
  const { rows } = await pool.query(`
    INSERT INTO admin_notifications (type, job_id, business_name, message)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [type, job_id || null, business_name || null, message]);
  return rows[0];
}

// ── DASHBOARD AGGREGATES ───────────────────────────────────────────────────────

async function getDashboardStats() {
  const [totalResult, awaitingResult, inDevResult, deliveredResult] = await Promise.all([
    pool.query(`SELECT COUNT(*) as count FROM customers`),
    pool.query(`SELECT COUNT(*) as count FROM customers WHERE project_status = 'pending_approval'`),
    pool.query(`SELECT COUNT(*) as count FROM customers WHERE project_status IN ('approved', 'in_development', 'preview_ready', 'changes_requested')`),
    pool.query(`
      SELECT COUNT(*) as count FROM customers
      WHERE project_status = 'delivered'
        AND created_at >= date_trunc('month', NOW())
    `)
  ]);
  return {
    total_jobs: parseInt(totalResult.rows[0].count),
    awaiting_approval: parseInt(awaitingResult.rows[0].count),
    in_development: parseInt(inDevResult.rows[0].count),
    delivered_this_month: parseInt(deliveredResult.rows[0].count)
  };
}

// Last 10 status changes across all jobs (using customers table created_at as proxy)
// In production a status_history table would be richer — this uses current data
async function getRecentActivity() {
  const { rows } = await pool.query(`
    SELECT job_id, business_name, name, project_status, created_at
    FROM customers
    ORDER BY created_at DESC
    LIMIT 10
  `);
  return rows;
}

// All jobs pending approval
async function getPendingApprovalJobs() {
  const { rows } = await pool.query(`
    SELECT customer_uuid, job_id, business_name, name, package_tier, project_status, created_at
    FROM customers
    WHERE project_status = 'pending_approval'
    ORDER BY created_at ASC
  `);
  return rows;
}

// All jobs (for Jobs list page in Part 2)
async function getAllJobs({ status, limit = 50, offset = 0 } = {}) {
  const params = [];
  let where = '';
  if (status && status !== 'all') {
    params.push(status);
    where = `WHERE project_status = $${params.length}`;
  }
  params.push(parseInt(limit) || 50);
  params.push(parseInt(offset) || 0);
  const { rows } = await pool.query(`
    SELECT customer_uuid, job_id, business_name, name, email, package_tier, project_status, created_at
    FROM customers
    ${where}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  return rows;
}

// Get single job detail by job_id
async function getJobByJobId(job_id) {
  const { rows } = await pool.query(`
    SELECT * FROM customers WHERE job_id = $1 LIMIT 1
  `, [job_id]);
  return rows[0] || null;
}

// Update job status
async function updateJobStatus(job_id, project_status) {
  const { rows } = await pool.query(`
    UPDATE customers SET project_status = $1 WHERE job_id = $2 RETURNING *
  `, [project_status, job_id]);
  return rows[0] || null;
}

// Update job package (package override)
async function updateJobPackage(job_id, package_tier) {
  const { rows } = await pool.query(`
    UPDATE customers SET package_tier = $1 WHERE job_id = $2 RETURNING *
  `, [package_tier, job_id]);
  return rows[0] || null;
}

// Flag a job (set status = 'flagged', store reason in metadata column if exists, else note)
async function flagJob(job_id, reason) {
  const { rows } = await pool.query(`
    UPDATE customers
    SET project_status = 'flagged'
    WHERE job_id = $1
    RETURNING *
  `, [job_id]);
  return rows[0] || null;
}

// Unflag a job (restore to previous status — default to pending_approval)
async function unflagJob(job_id) {
  const { rows } = await pool.query(`
    UPDATE customers
    SET project_status = 'pending_approval'
    WHERE job_id = $1 AND project_status = 'flagged'
    RETURNING *
  `, [job_id]);
  return rows[0] || null;
}

// Upsert a job overlay record for task status overrides when intake service is unavailable
// Uses a simple JSONB column on customers if it exists, otherwise falls back gracefully
async function upsertJobOverlay(job_id, overlayData) {
  // No-op if the overlay storage isn't wired — intake service is the source of truth
  // This is a best-effort local store when intake is down
  try {
    await pool.query(`
      UPDATE customers
      SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
      WHERE job_id = $2
    `, [JSON.stringify(overlayData), job_id]);
  } catch {
    // metadata column may not exist — silently ignore
  }
}

// Sync notifications from live DB state (idempotent — used before serving notifications)
async function syncNotificationsFromDB() {
  try {
    const newSubs = await pool.query(`
      SELECT c.job_id, COALESCE(c.business_name, c.name) as business_name
      FROM customers c
      WHERE c.created_at >= NOW() - INTERVAL '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM admin_notifications n
          WHERE n.job_id = c.job_id AND n.type = 'new_submission'
        )
    `);
    for (const row of newSubs.rows) {
      await createNotification({ type: 'new_submission', job_id: row.job_id, business_name: row.business_name, message: `${row.business_name || 'A client'} submitted a new project` });
    }
    const pendingApproval = await pool.query(`
      SELECT c.job_id, COALESCE(c.business_name, c.name) as business_name
      FROM customers c
      WHERE c.project_status = 'pending_approval'
        AND NOT EXISTS (
          SELECT 1 FROM admin_notifications n
          WHERE n.job_id = c.job_id AND n.type = 'awaiting_approval'
        )
    `);
    for (const row of pendingApproval.rows) {
      await createNotification({ type: 'awaiting_approval', job_id: row.job_id, business_name: row.business_name, message: `${row.business_name || 'A client'} job plan ready for review` });
    }
    const unreadMsgs = await pool.query(`
      SELECT DISTINCT m.job_id, COALESCE(c.business_name, c.name) as business_name
      FROM messages m
      JOIN customers c ON c.job_id = m.job_id
      WHERE m."from" = 'customer' AND m.read = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM admin_notifications n
          WHERE n.job_id = m.job_id AND n.type = 'customer_message'
            AND n.created_at >= NOW() - INTERVAL '1 hour'
        )
    `);
    for (const row of unreadMsgs.rows) {
      await createNotification({ type: 'customer_message', job_id: row.job_id, business_name: row.business_name, message: `${row.business_name || 'A client'} sent a message` });
    }
  } catch (err) {
    // Non-blocking — missing tables during migration is OK
    console.error('[AdminDB] syncNotifications error:', err.message);
  }
}

async function getLeadSourceStats() {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(NULLIF(utm_source, ''), 'direct') AS source,
      COUNT(*)::int AS count
    FROM contact_submissions
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY source
    ORDER BY count DESC
    LIMIT 10
  `);
  return rows;
}

// Hero CTA A/B test — submissions per variant over the last 14 days
async function getCtaVariantStats() {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(cta_variant, 'untracked') AS variant,
      COUNT(*)::int AS submissions
    FROM contact_submissions
    WHERE created_at >= NOW() - INTERVAL '14 days'
    GROUP BY variant
  `);
  return rows;
}

// FFMG Express hero CTA A/B test — intakes per variant over the days window
async function getExpressCtaVariantStats({ days = 30 }) {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(cta_variant, 'untracked') AS variant,
      COUNT(*)::int AS submissions
    FROM intake_submissions
    WHERE created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY variant
  `, [days]);
  return rows;
}

// Per-placement row count for [data-social-proof] markers across the FFMG Express
// funnel. Sharing visitor_id with page_views enables a future left-join against
// conversion tables, but for v1 a placement + page_path rollup is enough.
async function getSocialProofPlacements({ days = 30 }) {
  const { rows } = await pool.query(`
    SELECT
      placement,
      page_path,
      COUNT(*)::int AS views,
      COUNT(DISTINCT visitor_id)::int AS unique_visitors
    FROM social_proof_events
    WHERE created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY placement, page_path
    ORDER BY views DESC
  `, [days]);
  return rows;
}

// ── FFMG EXPRESS ATTRIBUTION ──────────────────────────────────────────────────
// Conversion attribution dashboard queries over a configurable days window.
// All utm columns were added by migrations 1746400000000 (page_views) and
// 1750521600 (contact_submissions, intake_submissions).

// Sessions grouped by utm_source + utm_medium, bucketing empty strings to
// 'direct' / 'none' so unattributed traffic still shows up.
async function getSessionsBySource({ days = 30 }) {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(NULLIF(utm_source, ''), 'direct')  AS source,
      COALESCE(NULLIF(utm_medium, ''), 'none')    AS medium,
      COUNT(DISTINCT visitor_id)::int             AS sessions
    FROM page_views
    WHERE created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY 1, 2
    ORDER BY sessions DESC
    LIMIT 50
  `, [days]);
  return rows;
}

// Contact-form conversion counts by source. Returns just the per-source
// submission count — client merges with getSessionsBySource() so sources
// with zero contacts still appear (e.g. organic/no-source).
async function getContactConversionsBySource({ days = 30 }) {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(NULLIF(utm_source, ''), 'direct') AS source,
      COUNT(*)::int                              AS contacts
    FROM contact_submissions
    WHERE created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY source
    ORDER BY contacts DESC
  `, [days]);
  return rows;
}

// Intake completion counts by source. Same shape as contact conversions —
// client merges with contact counts for the contact→intake funnel step.
async function getIntakeCompletionsBySource({ days = 30 }) {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(NULLIF(utm_source, ''), 'direct') AS source,
      COUNT(*)::int                              AS intakes
    FROM intake_submissions
    WHERE created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY source
    ORDER BY intakes DESC
  `, [days]);
  return rows;
}

// Top campaigns by ROI over the days window. Pipeline value uses the
// published package prices (Standard $2.5K, Premium $5K) with a $3.5K
// default when package is unknown / null.
async function getTopCampaignsByROI({ days = 30, limit = 5 }) {
  const { rows } = await pool.query(`
    SELECT
      pv.utm_source   AS source,
      pv.utm_campaign AS campaign,
      COUNT(DISTINCT pv.visitor_id)::int AS sessions,
      COALESCE(SUM(
        CASE
          WHEN i.package = 'premium'  THEN 5000
          WHEN i.package = 'standard' THEN 2500
          ELSE 3500
        END
      ), 0)::numeric AS pipeline_value
    FROM page_views pv
    LEFT JOIN intake_submissions i
      ON i.utm_source IS NOT DISTINCT FROM pv.utm_source
    WHERE pv.created_at >= NOW() - ($1 || ' days')::interval
      AND pv.utm_source IS NOT NULL
      AND pv.utm_campaign IS NOT NULL
    GROUP BY pv.utm_source, pv.utm_campaign
    ORDER BY pipeline_value DESC, sessions DESC
    LIMIT $2
  `, [days, limit]);
  return rows;
}

// Overall totals for the summary cards. Single round-trip via Promise.all
// at call site; conversion_rate derived client-side from contacts/sessions
// to avoid div-by-zero on a missing sessions row.
async function getOverallTotals({ days = 30 }) {
  const [sessions, contacts, intakes] = await Promise.all([
    pool.query(`
      SELECT COUNT(DISTINCT visitor_id)::int AS sessions
      FROM page_views
      WHERE created_at >= NOW() - ($1 || ' days')::interval
    `, [days]),
    pool.query(`
      SELECT COUNT(*)::int AS contacts
      FROM contact_submissions
      WHERE created_at >= NOW() - ($1 || ' days')::interval
    `, [days]),
    pool.query(`
      SELECT COUNT(*)::int AS intakes
      FROM intake_submissions
      WHERE created_at >= NOW() - ($1 || ' days')::interval
    `, [days])
  ]);
  return {
    sessions: sessions.rows[0].sessions,
    contacts: contacts.rows[0].contacts,
    intakes:  intakes.rows[0].intakes
  };
}

// Pricing hero variant attribution — per-variant (linkedin|twitter|google|direct) counts across
// sessions / contact submissions / intake submissions / portfolio reads in the days window.
// Returns one row per variant with all counts merged so callers can sort/pivot without
// re-merging client-side (e.g. LinkedIn with zero contacts still surfaces).
async function getPricingVariantSourceAttribution({ days = 30 }) {
  const [sessions, contacts, intakes, portfolioReads] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(NULLIF(pricing_variant_source, ''), 'direct') AS variant_source,
        COUNT(*)::int AS sessions
      FROM page_views
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY variant_source
    `, [days]),
    pool.query(`
      SELECT
        COALESCE(NULLIF(pricing_variant_source, ''), 'direct') AS variant_source,
        COUNT(*)::int AS contacts
      FROM contact_submissions
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY variant_source
    `, [days]),
    pool.query(`
      SELECT
        COALESCE(NULLIF(pricing_variant_source, ''), 'direct') AS variant_source,
        COUNT(*)::int AS intakes
      FROM intake_submissions
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY variant_source
    `, [days]),
    pool.query(`
      SELECT
        COALESCE(NULLIF(pricing_page.pricing_variant_source, ''), 'direct') AS variant_source,
        COUNT(*)::int AS portfolio_reads
      FROM page_views detail_page
      JOIN LATERAL (
        SELECT pricing_page.pricing_variant_source
        FROM page_views pricing_page
        WHERE pricing_page.visitor_id = detail_page.visitor_id
          AND pricing_page.page_path LIKE '/ffmg-express/pricing%'
          AND (
            pricing_page.created_at < detail_page.created_at
            OR (pricing_page.created_at = detail_page.created_at AND pricing_page.id < detail_page.id)
          )
        ORDER BY pricing_page.created_at DESC, pricing_page.id DESC
        LIMIT 1
      ) pricing_page ON TRUE
      WHERE detail_page.page_path ~ '^/work/[^/?]+([?].*)?$'
        AND detail_page.created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY variant_source
    `, [days])
  ]);
  const merged = new Map();
  for (const r of sessions.rows)  merged.set(r.variant_source, { variant_source: r.variant_source, sessions: r.sessions, contacts: 0, intakes: 0, portfolio_reads: 0 });
  for (const r of contacts.rows) {
    const cur = merged.get(r.variant_source) || { variant_source: r.variant_source, sessions: 0, contacts: 0, intakes: 0, portfolio_reads: 0 };
    cur.contacts = r.contacts;
    merged.set(r.variant_source, cur);
  }
  for (const r of intakes.rows) {
    const cur = merged.get(r.variant_source) || { variant_source: r.variant_source, sessions: 0, contacts: 0, intakes: 0, portfolio_reads: 0 };
    cur.intakes = r.intakes;
    merged.set(r.variant_source, cur);
  }
  for (const r of portfolioReads.rows) {
    const cur = merged.get(r.variant_source) || { variant_source: r.variant_source, sessions: 0, contacts: 0, intakes: 0, portfolio_reads: 0 };
    cur.portfolio_reads = r.portfolio_reads;
    merged.set(r.variant_source, cur);
  }
  return Array.from(merged.values());
}

// Stored 14-day re-baseline comparison. Uses the baseline's rolling-window
// size so the dashboard compares like-for-like completed snapshots.
async function getRebaselineLiftSummary() {
  const { rows } = await pool.query(`
    SELECT
      baseline.snapshot_date AS baseline_date,
      baseline.days_window AS rolling_window_days,
      baseline.sessions AS baseline_sessions,
      baseline.contacts AS baseline_contacts,
      baseline.conversion_rate AS baseline_conversion_rate,
      latest.snapshot_date AS current_date,
      latest.sessions AS current_sessions,
      latest.contacts AS current_contacts,
      latest.conversion_rate AS current_conversion_rate
    FROM (
      SELECT snapshot_date, days_window, sessions, contacts, conversion_rate
      FROM attribution_snapshots
      WHERE is_baseline = TRUE
      ORDER BY snapshot_date ASC
      LIMIT 1
    ) baseline
    LEFT JOIN LATERAL (
      SELECT snapshot_date, sessions, contacts, conversion_rate
      FROM attribution_snapshots
      WHERE is_baseline = FALSE
        AND days_window = baseline.days_window
        AND snapshot_date >= baseline.snapshot_date + INTERVAL '14 days'
        AND snapshot_date <= CURRENT_DATE
      ORDER BY snapshot_date DESC
      LIMIT 1
    ) latest ON TRUE
  `);

  if (!rows.length) {
    return {
      status: 'pending',
      available: false,
      reason: 'baseline_missing',
      qualification_days: 14,
      rolling_window_days: null
    };
  }

  const row = rows[0];
  const rollingWindowDays = Number(row.rolling_window_days);
  const baseline = {
    snapshot_date: row.baseline_date,
    sessions: row.baseline_sessions,
    contacts: row.baseline_contacts,
    conversion_rate: row.baseline_conversion_rate
  };

  if (row.current_date == null) {
    return {
      status: 'pending',
      available: false,
      reason: 'rollup_pending',
      qualification_days: 14,
      rolling_window_days: rollingWindowDays,
      baseline
    };
  }

  return {
    status: 'available',
    available: true,
    qualification_days: 14,
    rolling_window_days: rollingWindowDays,
    baseline,
    current: {
      snapshot_date: row.current_date,
      sessions: row.current_sessions,
      contacts: row.current_contacts,
      conversion_rate: row.current_conversion_rate
    }
  };
}

module.exports = {
  getNotifications,
  getUnreadCount,
  markNotificationsRead,
  createNotification,
  getDashboardStats,
  getRecentActivity,
  getPendingApprovalJobs,
  getAllJobs,
  getJobByJobId,
  updateJobStatus,
  updateJobPackage,
  flagJob,
  unflagJob,
  upsertJobOverlay,
  syncNotificationsFromDB,
  getLeadSourceStats,
  getCtaVariantStats,
  getExpressCtaVariantStats,
  getSocialProofPlacements,
  getSessionsBySource,
  getContactConversionsBySource,
  getIntakeCompletionsBySource,
  getTopCampaignsByROI,
  getOverallTotals,
  getPricingVariantSourceAttribution,
  getRebaselineLiftSummary
};

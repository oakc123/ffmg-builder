// Daily FFMG Express attribution snapshot + 14-day re-baseline report.
//
// Runs as a standalone node process via [[crons]] in polsia.toml.
// Bootstrap: reuse the application pool, run the same six dashboard queries the
// admin route runs (db/admin.js), persist the day's 30-day window snapshot,
// and on the deadline date (baseline.snapshot_date + 14 days) email the
// owner a side-by-side lift report against the seed baseline.
//
// Idempotent:
//   - daily snapshot insert is guarded by a same-day existence check
//   - comparison email send flips comparison_email_sent = TRUE; re-runs
//     skip the send
'use strict';

const pool = require('../db');
const apiKey = process.env.POLSIA_API_KEY;
const REPORT_EMAIL = 'amer.child@funkfactorymediagroup.com';
const EMAIL_PROXY_URL = 'https://polsia.com/api/proxy/email/send';
const BASELINE_DAYS = 30;
const REBASELINE_DAYS = 14;
const REBASELINE_DELAY_DAYS = 14;
let poolClosed = false;

async function closePool() {
  if (poolClosed) return;
  poolClosed = true;
  await pool.end();
}

async function computeAttribution(days) {
  // Use the named dashboard queries, which share the application pool.
  const admin = require('../db/admin');
  const [overall, sessions, contacts, intakes, top, pricing_variants] = await Promise.all([
    admin.getOverallTotals({ days }),
    admin.getSessionsBySource({ days }),
    admin.getContactConversionsBySource({ days }),
    admin.getIntakeCompletionsBySource({ days }),
    admin.getTopCampaignsByROI({ days, limit: 5 }),
    admin.getPricingVariantSourceAttribution({ days })
  ]);
  const conversion_rate = overall.sessions > 0
    ? Number(((overall.contacts / overall.sessions) * 100).toFixed(3))
    : 0;
  return {
    overall,
    conversion_rate,
    utm_breakdown: mergeBySource3(sessions, contacts, intakes),
    top_campaigns: top,
    pricing_variants
  };
}

function mergeBySource3(sessionsRows, contactsRows, intakesRows) {
  const m = new Map();
  for (const r of sessionsRows) {
    m.set(r.source, { source: r.source, medium: r.medium, sessions: r.sessions });
  }
  for (const r of contactsRows) {
    const cur = m.get(r.source) || { source: r.source };
    cur.contacts = r.contacts;
    m.set(r.source, cur);
  }
  for (const r of intakesRows) {
    const cur = m.get(r.source) || { source: r.source };
    cur.intakes = r.intakes;
    m.set(r.source, cur);
  }
  return Array.from(m.values());
}

function pct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return `${n.toFixed(1)}%`;
}

function signedDiff(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  const v = Math.round(n);
  return v >= 0 ? `+${v}` : `${v}`;
}

async function insertDailySnapshot(today) {
  const { rows } = await pool.query(`
    SELECT 1 FROM attribution_snapshots
    WHERE snapshot_date = CURRENT_DATE
      AND days_window = $1
      AND is_baseline = FALSE
    LIMIT 1
  `, [BASELINE_DAYS]);
  if (rows.length > 0) {
    console.log(`[Snapshot] Daily snapshot already exists for ${today} (${BASELINE_DAYS}d); skipping insert.`);
    return false;
  }
  const snap = await computeAttribution(BASELINE_DAYS);
  await pool.query({
    text: `
      INSERT INTO attribution_snapshots
        (snapshot_date, days_window, sessions, contacts, intakes,
         conversion_rate, utm_breakdown, top_campaigns, pricing_variants, is_baseline)
      VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, FALSE)
    `,
    values: [
      BASELINE_DAYS,
      snap.overall.sessions,
      snap.overall.contacts,
      snap.overall.intakes,
      snap.conversion_rate,
      JSON.stringify(snap.utm_breakdown),
      JSON.stringify(snap.top_campaigns),
      JSON.stringify(snap.pricing_variants)
    ]
  });
  console.log(`[Snapshot] Inserted daily ${BASELINE_DAYS}d snapshot for ${today}: ` +
    `${snap.overall.sessions} PV / ${snap.overall.contacts} contacts / ${snap.overall.intakes} intakes ` +
    `(${pct(snap.conversion_rate)} conversion).`);
  return true;
}

async function loadBaseline() {
  const { rows } = await pool.query(`
    SELECT * FROM attribution_snapshots WHERE is_baseline = TRUE LIMIT 1
  `);
  return rows[0] || null;
}

async function loadLatestPostWindow() {
  const { rows } = await pool.query(`
    SELECT * FROM attribution_snapshots
    WHERE days_window = $1
    ORDER BY snapshot_date DESC
    LIMIT 1
  `, [REBASELINE_DAYS]);
  return rows[0] || null;
}

function buildEmailBody({ baseline, post, baselineLabel, postLabel }) {
  const dSessions = post.overall.sessions - baseline.overall.sessions;
  const dContacts = post.overall.contacts - baseline.overall.contacts;
  const dIntakes = post.overall.intakes - baseline.overall.intakes;
  const dRate = post.conversion_rate - baseline.conversion_rate;
  const relRate = baseline.conversion_rate > 0
    ? (dRate / baseline.conversion_rate) * 100
    : null;

  const baselineUtm = new Map((baseline.utm_breakdown || []).map(r => [r.source, r]));
  const postUtm = new Map((post.utm_breakdown || []).map(r => [r.source, r]));
  const allSources = new Set([...baselineUtm.keys(), ...postUtm.keys()]);
  const movers = Array.from(allSources).map(source => {
    const b = baselineUtm.get(source) || {};
    const p = postUtm.get(source) || {};
    return {
      source,
      dSessions: (p.sessions || 0) - (b.sessions || 0),
      dContacts: (p.contacts || 0) - (b.contacts || 0)
    };
  }).sort((a, b) => (b.dContacts - a.dContacts) || (b.dSessions - a.dSessions))
    .slice(0, 5);

  const pricingVariantLabels = [
    ['linkedin', 'LinkedIn'],
    ['twitter', 'Twitter'],
    ['google', 'Google'],
    ['direct', 'Direct']
  ];
  const baselinePricing = new Map((baseline.pricing_variants || []).map(r => [r.variant_source, r]));
  const postPricing = new Map((post.pricing_variants || []).map(r => [r.variant_source, r]));
  const portfolioReadLines = pricingVariantLabels.map(([source, label]) => {
    const baselineReads = Number(baselinePricing.get(source)?.portfolio_reads || 0);
    const postReads = Number(postPricing.get(source)?.portfolio_reads || 0);
    return `  ${label}: ${baselineReads} → ${postReads} (${signedDiff(postReads - baselineReads)})`;
  });

  const lines = [
    `FFMG Express — 14-day re-baseline report`,
    ``,
    `Window comparison: ${baselineLabel} vs ${postLabel}`,
    ``,
    `Totals`,
    `  Sessions:        ${baseline.overall.sessions} → ${post.overall.sessions}  (${signedDiff(dSessions)})`,
    `  Contacts:        ${baseline.overall.contacts} → ${post.overall.contacts}  (${signedDiff(dContacts)})`,
    `  Intakes:         ${baseline.overall.intakes} → ${post.overall.intakes}  (${signedDiff(dIntakes)})`,
    `  Conversion rate: ${pct(baseline.conversion_rate)} → ${pct(post.conversion_rate)}  (${signedDiff(dRate)} pp; ${relRate === null ? 'n/a' : signedDiff(relRate) + '% rel'})`,
    ``,
    `Portfolio reads by pricing variant (baseline → post; signed delta)`,
    ...portfolioReadLines,
    ``,
    `Top movers by source`,
    ...movers.map(m => `  ${m.source}: sessions ${signedDiff(m.dSessions)}, contacts ${signedDiff(m.dContacts)}`),
    ``,
    `Capture this lift alongside the testimonials, UTM fix, social promo, and CTA copy changes to attribute the gain.`,
    ``,
    `Dashboard: https://funkfactoryos.polsia.app/dashboard/ffmg-express`
  ];
  return lines.join('\n');
}

async function sendReportEmail(body) {
  if (!apiKey) {
    console.warn('[Snapshot] POLSIA_API_KEY not set — comparison email skipped after snapshot work completed.');
    if (process.env.DEBUG_EMAIL === 'true') console.log('EMAIL BODY:', body);
    return { skipped: true };
  }
  try {
    const subject = 'FFMG Express — 14-day re-baseline report';
    const res = await fetch(EMAIL_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ to: REPORT_EMAIL, subject, body }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      throw new Error(`Email proxy returned HTTP ${res.status}`);
    }
    console.log(`[Snapshot] Comparison email sent to ${REPORT_EMAIL}.`);
    return { sent: true };
  } catch (err) {
    console.error('[Snapshot] Email send failed:', err.message);
    throw err;
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[Snapshot] Cron tick @ ${today}`);

  await insertDailySnapshot(today);

  const baseline = await loadBaseline();
  if (!baseline) {
    console.log('[Snapshot] No baseline row present — comparison will be sent once the migration has applied. Exiting 0.');
    return;
  }
  if (baseline.comparison_email_sent) {
    console.log('[Snapshot] Baseline comparison already sent; exiting 0 (idempotent re-fire guard).');
    return;
  }

  const baselineDate = baseline.snapshot_date instanceof Date
    ? baseline.snapshot_date.toISOString().slice(0, 10)
    : String(baseline.snapshot_date);
  const deadline = new Date(baselineDate);
  deadline.setUTCDate(deadline.getUTCDate() + REBASELINE_DELAY_DAYS);
  const deadlineStr = deadline.toISOString().slice(0, 10);
  const forceDeadline = process.env.FORCE_DEADLINE === 'true';

  if (!forceDeadline && today < deadlineStr) {
    console.log(`[Snapshot] Deadline ${deadlineStr} not yet reached (today=${today}). No comparison email.`);
    return;
  }
  if (forceDeadline) {
    console.log(`[Snapshot] FORCE_DEADLINE=true — bypassing date check (deadline=${deadlineStr}).`);
  }

  // Pull a previously captured 14-day window snapshot, or compute one live.
  const stored = await loadLatestPostWindow();
  let post;
  let postLabel;
  if (stored) {
    const storedDate = stored.snapshot_date instanceof Date
      ? stored.snapshot_date.toISOString().slice(0, 10)
      : String(stored.snapshot_date);
    postLabel = `${storedDate} (14d window, stored)`;
    post = {
      overall: { sessions: stored.sessions, contacts: stored.contacts, intakes: stored.intakes },
      conversion_rate: stored.conversion_rate,
      utm_breakdown: stored.utm_breakdown || [],
      top_campaigns: stored.top_campaigns || [],
      pricing_variants: stored.pricing_variants || []
    };
    console.log(`[Snapshot] Using stored 14d post snapshot from ${storedDate}.`);
  } else {
    post = await computeAttribution(REBASELINE_DAYS);
    postLabel = `${today} (14d window, live)`;
    console.log(`[Snapshot] No stored 14d snapshot found — computing live for ${today}.`);
  }

  // Hydrate the baseline row into the same shape as `post` so buildEmailBody
  // can read baseline.overall.* uniformly.
  const baselineShape = {
    overall: {
      sessions: baseline.sessions,
      contacts: baseline.contacts,
      intakes:  baseline.intakes
    },
    conversion_rate: Number(baseline.conversion_rate),
    utm_breakdown: baseline.utm_breakdown || [],
    pricing_variants: baseline.pricing_variants || []
  };

  const baselineLabel = `${baselineDate} (30d window baseline)`;
  const body = buildEmailBody({ baseline: baselineShape, post, baselineLabel, postLabel });
  if (process.env.DEBUG_EMAIL === 'true') console.log('EMAIL BODY:', body);

  const delivery = await sendReportEmail(body);
  if (delivery.skipped) {
    console.log('[Snapshot] Comparison email remains pending until POLSIA_API_KEY is configured.');
    return;
  }

  await pool.query(
    `UPDATE attribution_snapshots SET comparison_email_sent = TRUE WHERE id = $1`,
    [baseline.id]
  );
  console.log(`[Snapshot] Flipped comparison_email_sent = TRUE on baseline row id=${baseline.id}.`);
}

main()
  .then(async () => { await closePool(); process.exit(0); })
  .catch(async err => {
    console.error('[Snapshot] Cron failed:', err.message);
    try { await closePool(); } catch (_) { /* ignore */ }
    process.exit(1);
  });

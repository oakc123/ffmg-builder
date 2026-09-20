// Migration: attribution_snapshots table + initial 30-day window baseline row.
// Stores a daily snapshot of FFMG Express conversion attribution so a future
// 14-day re-run can compute a side-by-side lift report against today's
// 1.1% baseline (268 PV / 3 submissions).
//
// Idempotent: CREATE TABLE / INDEX use IF NOT EXISTS; seed only runs when
// the migration is freshly applied (migrate.js tracks it in _migrations).
module.exports = {
  name: 'add_attribution_snapshots',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS attribution_snapshots (
        id SERIAL PRIMARY KEY,
        snapshot_date DATE NOT NULL,
        days_window INT NOT NULL,
        sessions INT,
        contacts INT,
        intakes INT,
        conversion_rate NUMERIC(6,3),
        utm_breakdown JSONB,
        top_campaigns JSONB,
        is_baseline BOOLEAN NOT NULL DEFAULT FALSE,
        comparison_email_sent BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS attribution_snapshots_snapshot_date_idx
      ON attribution_snapshots (snapshot_date DESC)
    `);

    // At most one baseline row. Partial unique index enforces this server-side.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS attribution_baseline_uniq
      ON attribution_snapshots ((TRUE)) WHERE is_baseline
    `);

    // Seed today's 30-day window as the baseline row. Uses the same five
    // queries the admin dashboard runs (db/admin.js) so the captured numbers
    // match what the dashboard shows today.
    const admin = require('../db/admin');

    const days = 30;
    const overall = await admin.getOverallTotals({ days });
    const sessions = await admin.getSessionsBySource({ days });
    const contacts = await admin.getContactConversionsBySource({ days });
    const intakes = await admin.getIntakeCompletionsBySource({ days });
    const top = await admin.getTopCampaignsByROI({ days, limit: 5 });

    const utm = mergeBySource3(sessions, contacts, intakes);
    const conversion_rate = overall.sessions > 0
      ? Number(((overall.contacts / overall.sessions) * 100).toFixed(3))
      : 0;

    await client.query({
      text: `
        INSERT INTO attribution_snapshots
          (snapshot_date, days_window, sessions, contacts, intakes,
           conversion_rate, utm_breakdown, top_campaigns, is_baseline)
        VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, TRUE)
      `,
      values: [
        days,
        overall.sessions,
        overall.contacts,
        overall.intakes,
        conversion_rate,
        JSON.stringify(utm),
        JSON.stringify(top)
      ]
    });
  }
};

// Three-way merge of sessions + contact conversions + intake completions
// on source. Mirrors the two-step merge in public/admin/ffmg-express.html
// (mergeBySource) flattened into a single pass so the JSONB blob holds one
// row per source with {source, medium, sessions, contacts, intakes}.
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

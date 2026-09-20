// Owns: express_nurture_sends table queries + Stage 2 / Stage 3 candidate lookup.
// Does NOT own: pool construction (db/index.js), contact submission writes (routes/contact.js).
const pool = require('./index');

// day-offset → numeric stage stored in express_nurture_sends.stage (1, 2, 3 only).
// Days 0 / 3 / 7 map to email stages 1, 2, 3 per the brief. Stage 1 is written
// from routes/contact.js on POST /api/contact success; this module never reads
// or writes stage 1 from the cron path.
const STAGE_BY_DAYS_AGO = { 3: 2, 7: 3 };

function stageForDaysAgo(daysAgo) {
  const stage = STAGE_BY_DAYS_AGO[daysAgo];
  if (!stage) throw new Error(`unsupported daysAgo=${daysAgo} (expected 3 or 7)`);
  return stage;
}

// ON CONFLICT DO NOTHING inside the INSERT so the caller doesn't need a
// separate preflight read. Returns the inserted row, or null when the
// (contact_id, stage) pair already existed. Accepts either the raw stage
// number (1/2/3) or a days-ago key (3/7) for caller convenience.
async function recordSend(contactId, stageOrDaysAgo, klaviyoEventId) {
  const stage = STAGE_BY_DAYS_AGO[stageOrDaysAgo] || stageOrDaysAgo;
  const { rows } = await pool.query(
    `INSERT INTO express_nurture_sends (contact_id, stage, klaviyo_event_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (contact_id, stage) DO NOTHING
     RETURNING *`,
    [contactId, stage, klaviyoEventId || null]
  );
  return rows[0] || null;
}

// queueableContactsForDay(daysAgo) — returns rows from contact_submissions
// whose created_at lands in the rolling 1-day window
// [now - (N+1 days), now - N days). daysAgo ∈ {3, 7} per STAGE_BY_DAYS_AGO.
// Excludes:
//   - contacts with a matching email in intake_submissions (already converted)
//   - contacts that already have a stage=STAGE_BY_DAYS_AGO[N] send row (idempotency)
async function queueableContactsForDay(daysAgo) {
  const stage = stageForDaysAgo(daysAgo);
  const { rows } = await pool.query(
    `SELECT cs.id         AS contact_id,
            cs.name       AS name,
            cs.email      AS email,
            cs.created_at AS created_at,
            $2::smallint  AS stage
       FROM contact_submissions cs
      WHERE cs.created_at >= NOW() - (($1 + 1) || ' days')::interval
        AND cs.created_at <  NOW() - ($1         || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM intake_submissions i
          WHERE LOWER(i.email) = LOWER(cs.email)
        )
        AND NOT EXISTS (
          SELECT 1 FROM express_nurture_sends e
          WHERE e.contact_id = cs.id AND e.stage = $2::smallint
        )
      ORDER BY cs.created_at ASC`,
    [daysAgo, stage]
  );
  return rows;
}

// Per-window breakdown — total contacts in the day window, already-converted
// (intake match), already-sent (matching express_nurture_sends stage row), and
// the queueable remainder. Used by the cron so operators can spot drift.
async function windowStats(daysAgo) {
  const stage = stageForDaysAgo(daysAgo);
  const { rows } = await pool.query(
    `WITH contact_window AS (
       SELECT cs.id, LOWER(cs.email) AS email
         FROM contact_submissions cs
        WHERE cs.created_at >= NOW() - (($1 + 1) || ' days')::interval
          AND cs.created_at <  NOW() - ($1         || ' days')::interval
     ),
     converted AS (
       SELECT w.id FROM contact_window w
       WHERE EXISTS (SELECT 1 FROM intake_submissions i WHERE LOWER(i.email) = w.email)
     ),
     sent AS (
       SELECT w.id FROM contact_window w
       WHERE EXISTS (SELECT 1 FROM express_nurture_sends e WHERE e.contact_id = w.id AND e.stage = $2::smallint)
     )
     SELECT
       (SELECT COUNT(*) FROM contact_window)::int     AS total_in_window,
       (SELECT COUNT(*) FROM converted)::int  AS already_converted,
       (SELECT COUNT(*) FROM sent)::int       AS already_sent,
       (SELECT COUNT(*) FROM contact_window w
          WHERE w.id NOT IN (SELECT id FROM converted)
            AND w.id NOT IN (SELECT id FROM sent)
       )::int                                  AS candidates`,
    [daysAgo, stage]
  );
  return rows[0];
}

module.exports = { recordSend, queueableContactsForDay, windowStats };

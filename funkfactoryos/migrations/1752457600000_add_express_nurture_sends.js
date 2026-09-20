// Migration: FFMG Express lead-nurture send tracking.
// One row per (contact_submission, stage) — records when Stage 1 / 2 / 3 fires.
// PK on (contact_id, stage) makes the cron re-fire idempotent at the DB layer;
// routes/contact.js and jobs/express-lead-nurture-daily.js both use ON CONFLICT
// DO NOTHING to guard against duplicate Klaviyo Track Event posts.
module.exports = {
  name: 'add_express_nurture_sends',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS express_nurture_sends (
        contact_id        INTEGER NOT NULL REFERENCES contact_submissions(id) ON DELETE CASCADE,
        stage             SMALLINT NOT NULL CHECK (stage IN (1, 2, 3)),
        sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        klaviyo_event_id  VARCHAR(255),
        PRIMARY KEY (contact_id, stage)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS express_nurture_sends_stage_sent_at_idx
        ON express_nurture_sends (stage, sent_at DESC)
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS express_nurture_sends`);
  }
};

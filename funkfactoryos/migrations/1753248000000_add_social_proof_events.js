// Migration: Social proof placement-view tracking.
// One row per (placement, page_path, visitor) when a [data-social-proof] marker
// scrolls into view on a FFMG Express funnel page. Powers the
// /dashboard/ffmg-express "Social proof placements" attribution card so the team
// can compare conversion lift across funnel depth.
module.exports = {
  name: 'add_social_proof_events',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS social_proof_events (
        id BIGSERIAL PRIMARY KEY,
        placement VARCHAR(64) NOT NULL,
        page_path VARCHAR(500) NOT NULL,
        visitor_id VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS social_proof_events_placement_created_idx
        ON social_proof_events (placement, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS social_proof_events_visitor_idx
        ON social_proof_events (visitor_id)
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS social_proof_events`);
  }
};

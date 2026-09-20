module.exports = {
  name: 'add_page_views',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS page_views (
        id BIGSERIAL PRIMARY KEY,
        visitor_id VARCHAR(64) NOT NULL,
        page_path VARCHAR(500) NOT NULL,
        referrer VARCHAR(1000),
        user_agent VARCHAR(500),
        country VARCHAR(100),
        site VARCHAR(50) NOT NULL DEFAULT 'ffmg',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS page_views_created_at_idx ON page_views (created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS page_views_site_created_idx ON page_views (site, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS page_views_page_path_idx ON page_views (page_path)
    `);
  }
};

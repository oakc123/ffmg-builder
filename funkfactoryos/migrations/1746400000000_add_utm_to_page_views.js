module.exports = {
  name: 'add_utm_to_page_views',
  up: async (client) => {
    await client.query(`
      ALTER TABLE page_views
        ADD COLUMN IF NOT EXISTS utm_source   VARCHAR(200),
        ADD COLUMN IF NOT EXISTS utm_medium   VARCHAR(200),
        ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(200),
        ADD COLUMN IF NOT EXISTS utm_content  VARCHAR(200)
    `);

    // Index for fast utm_source grouping on the analytics dashboard
    await client.query(`
      CREATE INDEX IF NOT EXISTS page_views_utm_source_idx
        ON page_views (utm_source)
        WHERE utm_source IS NOT NULL
    `);
  },
};

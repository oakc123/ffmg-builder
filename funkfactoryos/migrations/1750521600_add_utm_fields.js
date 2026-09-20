module.exports = {
  name: 'add_utm_fields',
  up: async (client) => {
    await client.query(`
      ALTER TABLE contact_submissions
        ADD COLUMN IF NOT EXISTS utm_source   VARCHAR(200),
        ADD COLUMN IF NOT EXISTS utm_medium   VARCHAR(200),
        ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(200),
        ADD COLUMN IF NOT EXISTS referrer     VARCHAR(500)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS contact_submissions_utm_source_idx
        ON contact_submissions (utm_source)
        WHERE utm_source IS NOT NULL
    `);

    await client.query(`
      ALTER TABLE intake_submissions
        ADD COLUMN IF NOT EXISTS utm_source   VARCHAR(200),
        ADD COLUMN IF NOT EXISTS utm_medium   VARCHAR(200),
        ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(200)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS intake_submissions_utm_source_idx
        ON intake_submissions (utm_source)
        WHERE utm_source IS NOT NULL
    `);
  }
};
module.exports = {
  name: 'add_pricing_variant_source',
  up: async (client) => {
    await client.query(`
      ALTER TABLE page_views
        ADD COLUMN IF NOT EXISTS pricing_variant_source VARCHAR(20)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS page_views_pricing_variant_source_idx
        ON page_views (pricing_variant_source)
        WHERE pricing_variant_source IS NOT NULL
    `);

    await client.query(`
      ALTER TABLE contact_submissions
        ADD COLUMN IF NOT EXISTS pricing_variant_source VARCHAR(20)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS contact_submissions_pricing_variant_source_idx
        ON contact_submissions (pricing_variant_source)
        WHERE pricing_variant_source IS NOT NULL
    `);

    await client.query(`
      ALTER TABLE intake_submissions
        ADD COLUMN IF NOT EXISTS pricing_variant_source VARCHAR(20)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS intake_submissions_pricing_variant_source_idx
        ON intake_submissions (pricing_variant_source)
        WHERE pricing_variant_source IS NOT NULL
    `);
  }
};

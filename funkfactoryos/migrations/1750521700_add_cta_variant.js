module.exports = {
  name: 'add_cta_variant',
  up: async (client) => {
    await client.query(`
      ALTER TABLE contact_submissions
        ADD COLUMN IF NOT EXISTS cta_variant VARCHAR(20)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS contact_submissions_cta_variant_idx
        ON contact_submissions (cta_variant)
        WHERE cta_variant IS NOT NULL
    `);
  }
};

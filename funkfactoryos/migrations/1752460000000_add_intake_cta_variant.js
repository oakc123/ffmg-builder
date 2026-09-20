module.exports = {
  name: 'add_intake_cta_variant',
  up: async (client) => {
    await client.query(`
      ALTER TABLE intake_submissions
        ADD COLUMN IF NOT EXISTS cta_variant VARCHAR(20)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS intake_submissions_cta_variant_idx
        ON intake_submissions (cta_variant)
        WHERE cta_variant IS NOT NULL
    `);
  }
};

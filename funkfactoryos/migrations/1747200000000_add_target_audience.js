module.exports = {
  name: 'add_target_audience',
  up: async (client) => {
    // Add target_audience column to intake_submissions (required by homelab webhook schema)
    await client.query(`
      ALTER TABLE intake_submissions ADD COLUMN IF NOT EXISTS target_audience TEXT
    `);
  }
};

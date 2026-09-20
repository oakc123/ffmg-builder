module.exports = {
  name: 'add_contact_submissions',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS contact_submissions (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        event_type VARCHAR(100) NOT NULL,
        event_date DATE,
        venue VARCHAR(255),
        message TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'new',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS contact_submissions_email_idx ON contact_submissions (email)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS contact_submissions_status_idx ON contact_submissions (status)
    `);
  }
};

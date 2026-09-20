module.exports = {
  name: 'add_gigs',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS gigs (
        id SERIAL PRIMARY KEY,
        client_name VARCHAR(255) NOT NULL,
        event_name VARCHAR(255) NOT NULL,
        event_type VARCHAR(50) NOT NULL DEFAULT 'concert',
        event_date DATE,
        location VARCHAR(255),
        status VARCHAR(50) NOT NULL DEFAULT 'inquiry',
        price NUMERIC(10,2),
        notes TEXT,
        contact_email VARCHAR(255),
        contact_phone VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS gigs_status_idx ON gigs (status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS gigs_event_date_idx ON gigs (event_date)
    `);
  }
};

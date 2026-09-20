module.exports = {
  name: 'add_intake_submissions',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS intake_submissions (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        business_name TEXT NOT NULL,
        existing_website TEXT,
        package TEXT,
        timeline TEXT,
        description TEXT,
        budget_confirm TEXT,
        competitors TEXT,
        color1 TEXT,
        color2 TEXT,
        color3 TEXT,
        fonts TEXT,
        style_pref TEXT,
        additional_notes TEXT,
        has_logo BOOLEAN DEFAULT false,
        image_count INTEGER DEFAULT 0,
        source_url TEXT,
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS intake_submissions_email_idx ON intake_submissions (email)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS intake_submissions_created_at_idx ON intake_submissions (created_at DESC)
    `);
  }
};

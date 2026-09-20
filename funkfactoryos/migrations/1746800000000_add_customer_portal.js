// Migration: customer portal tables (customers, messages, magic_link_tokens, project_progress)
module.exports = {
  name: 'add_customer_portal',
  up: async (client) => {
    // customers — one row per web design client
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        customer_uuid UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        business_name TEXT,
        package_tier TEXT,
        project_status TEXT NOT NULL DEFAULT 'intake_received',
        job_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS customers_uuid_idx ON customers (customer_uuid)`);
    await client.query(`CREATE INDEX IF NOT EXISTS customers_job_id_idx ON customers (job_id)`);

    // messages — threaded messages between client and FFMG team per job
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        message_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        job_id TEXT NOT NULL,
        customer_uuid UUID NOT NULL,
        "from" TEXT NOT NULL CHECK ("from" IN ('customer', 'agent')),
        body TEXT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        read BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS messages_job_id_idx ON messages (job_id, sent_at ASC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS messages_customer_uuid_idx ON messages (customer_uuid)`);

    // magic_link_tokens — short-lived login tokens; optional row per send
    await client.query(`
      CREATE TABLE IF NOT EXISTS magic_link_tokens (
        id SERIAL PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        customer_uuid UUID NOT NULL,
        job_id TEXT,
        email TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS magic_link_tokens_hash_idx ON magic_link_tokens (token_hash)`);
    await client.query(`CREATE INDEX IF NOT EXISTS magic_link_tokens_expires_idx ON magic_link_tokens (expires_at)`);

    // project_progress — preview URLs / milestone notes posted by FFMG team
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_progress (
        id SERIAL PRIMARY KEY,
        customer_uuid UUID NOT NULL,
        job_id TEXT,
        url TEXT,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS project_progress_uuid_idx ON project_progress (customer_uuid, created_at DESC)`);

    // Extend intake_submissions to store customer_uuid linkage
    await client.query(`
      ALTER TABLE intake_submissions ADD COLUMN IF NOT EXISTS customer_uuid UUID
    `);
    await client.query(`
      ALTER TABLE intake_submissions ADD COLUMN IF NOT EXISTS job_id TEXT
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS project_progress`);
    await client.query(`DROP TABLE IF EXISTS magic_link_tokens`);
    await client.query(`DROP TABLE IF EXISTS messages`);
    await client.query(`DROP TABLE IF EXISTS customers`);
    await client.query(`ALTER TABLE intake_submissions DROP COLUMN IF EXISTS customer_uuid`);
    await client.query(`ALTER TABLE intake_submissions DROP COLUMN IF EXISTS job_id`);
  }
};

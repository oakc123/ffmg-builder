// Migration: add preview delivery columns to customers table
// Stores the latest preview build data sent from homelab assistant
module.exports = {
  name: 'add_preview_to_customers',
  up: async (client) => {
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS preview_url TEXT`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS preview_expires_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS preview_package TEXT`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS preview_pages_built JSONB`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS preview_built_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS preview_notes TEXT`);
    // external_message_id — allows agent-reply dedup without altering the messages table UNIQUE constraint
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS external_message_id TEXT`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS messages_external_message_id_idx
      ON messages (external_message_id)
      WHERE external_message_id IS NOT NULL
    `);
  },
  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS messages_external_message_id_idx`);
    await client.query(`ALTER TABLE messages DROP COLUMN IF EXISTS external_message_id`);
    await client.query(`ALTER TABLE customers DROP COLUMN IF EXISTS preview_notes`);
    await client.query(`ALTER TABLE customers DROP COLUMN IF EXISTS preview_built_at`);
    await client.query(`ALTER TABLE customers DROP COLUMN IF EXISTS preview_pages_built`);
    await client.query(`ALTER TABLE customers DROP COLUMN IF EXISTS preview_package`);
    await client.query(`ALTER TABLE customers DROP COLUMN IF EXISTS preview_expires_at`);
    await client.query(`ALTER TABLE customers DROP COLUMN IF EXISTS preview_url`);
  }
};

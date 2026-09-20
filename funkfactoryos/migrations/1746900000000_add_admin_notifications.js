// Migration: admin_notifications table — stores notification state for admin portal bell
module.exports = {
  name: 'add_admin_notifications',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_notifications (
        id SERIAL PRIMARY KEY,
        notification_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        type TEXT NOT NULL,
        job_id TEXT,
        business_name TEXT,
        message TEXT NOT NULL,
        read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS admin_notifications_read_idx ON admin_notifications (read)`);
    await client.query(`CREATE INDEX IF NOT EXISTS admin_notifications_created_idx ON admin_notifications (created_at DESC)`);
  }
};

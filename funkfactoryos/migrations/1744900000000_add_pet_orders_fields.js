module.exports = {
  name: 'add_pet_orders_fields',
  up: async (client) => {
    // Add email tracking (so we only send one notification per order)
    await client.query(`
      ALTER TABLE pet_orders
        ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS cj_order_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS fulfillment_notes TEXT
    `);
  }
};

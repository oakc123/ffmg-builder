module.exports = {
  name: 'add_pet_orders',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pet_orders (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        phone VARCHAR(50),
        shipping_address JSONB DEFAULT '{}',
        status VARCHAR(50) DEFAULT 'pending',
        subtotal_cents INTEGER NOT NULL DEFAULT 0,
        shipping_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL DEFAULT 0,
        stripe_session_id VARCHAR(255),
        stripe_payment_intent_id VARCHAR(255),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pet_order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES pet_orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES pet_products(id) ON DELETE SET NULL,
        product_name VARCHAR(255) NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price_cents INTEGER NOT NULL,
        product_snapshot JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS pet_orders_email_idx ON pet_orders (email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS pet_orders_status_idx ON pet_orders (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS pet_orders_stripe_session_idx ON pet_orders (stripe_session_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS pet_order_items_order_id_idx ON pet_order_items (order_id)`);
  }
};

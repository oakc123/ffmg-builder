module.exports = {
  name: 'add_gallery_photos',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS gallery_photos (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL,
        caption VARCHAR(255) DEFAULT '',
        category VARCHAR(50) NOT NULL DEFAULT 'sports',
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS gallery_photos_category_idx ON gallery_photos (category)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS gallery_photos_sort_idx ON gallery_photos (sort_order)
    `);
  }
};

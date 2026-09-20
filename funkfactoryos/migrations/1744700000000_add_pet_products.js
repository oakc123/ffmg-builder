module.exports = {
  name: 'add_pet_products',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pet_products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL UNIQUE,
        description TEXT,
        price_cents INTEGER NOT NULL,
        compare_price_cents INTEGER,
        image_url TEXT,
        images JSONB DEFAULT '[]',
        category VARCHAR(100) NOT NULL DEFAULT 'accessories',
        tags JSONB DEFAULT '[]',
        in_stock BOOLEAN DEFAULT true,
        featured BOOLEAN DEFAULT false,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS pet_products_slug_idx ON pet_products (slug)`);
    await client.query(`CREATE INDEX IF NOT EXISTS pet_products_category_idx ON pet_products (category)`);
    await client.query(`CREATE INDEX IF NOT EXISTS pet_products_featured_idx ON pet_products (featured)`);

    // Seed 17 products
    const products = [
      {
        name: 'Dog Snuffle Mat',
        slug: 'dog-snuffle-mat',
        description: 'Give your dog the gift of mental stimulation! This snuffle mat hides treats in its fleece ribbons, turning mealtime into a fun foraging adventure. Great for anxiety, slow feeding, and keeping high-energy pups engaged. Machine washable.',
        price_cents: 1800,
        compare_price_cents: 2899,
        image_url: 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=800&q=80']),
        category: 'dogs',
        tags: JSON.stringify(['enrichment', 'feeding', 'anxiety-relief']),
        featured: true,
        sort_order: 1
      },
      {
        name: 'Automatic Laser Cat Toy',
        slug: 'automatic-laser-cat-toy',
        description: 'Keep your cat entertained for hours without lifting a finger! This automatic laser toy rotates and beams in unpredictable patterns at 3 speed settings. Auto shuts off after 15 minutes to avoid overstimulation. USB rechargeable.',
        price_cents: 2000,
        compare_price_cents: 3499,
        image_url: 'https://images.unsplash.com/photo-1573865526739-10659fec78a5?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1573865526739-10659fec78a5?w=800&q=80']),
        category: 'cats',
        tags: JSON.stringify(['interactive', 'exercise', 'automatic']),
        featured: true,
        sort_order: 2
      },
      {
        name: 'Calming Anxiety Dog Bed',
        slug: 'calming-anxiety-dog-bed',
        description: 'Your dog deserves the ultimate nap spot. This ultra-soft, round bolster bed mimics a mother\'s embrace — perfect for anxious or nervous dogs. The raised rim supports aching joints and promotes deep, restful sleep. Removable, machine-washable cover.',
        price_cents: 2600,
        compare_price_cents: 4200,
        image_url: 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1548199973-03cce0bbc87b?w=800&q=80']),
        category: 'dogs',
        tags: JSON.stringify(['sleep', 'anxiety', 'comfort']),
        featured: true,
        sort_order: 3
      },
      {
        name: 'Dog Rope Toy Set (3-Pack)',
        slug: 'dog-rope-toy-set',
        description: 'Three colorful knotted rope toys that stand up to aggressive chewers. Great for tug-of-war, fetch, and dental health (the natural fibers act like floss). Comes in small, medium, and large sizes — one for every mood.',
        price_cents: 1400,
        compare_price_cents: 2199,
        image_url: 'https://images.unsplash.com/photo-1601758228041-f3b2795255f1?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1601758228041-f3b2795255f1?w=800&q=80']),
        category: 'dogs',
        tags: JSON.stringify(['toys', 'chew', 'dental']),
        featured: false,
        sort_order: 4
      },
      {
        name: 'Cat Collapsible Tunnel',
        slug: 'cat-collapsible-tunnel',
        description: 'Pop it open, watch your cat go feral (in the best way). This crinkly collapsible tunnel has two openings and a dangling pom-pom inside that drives cats absolutely wild. Folds flat in seconds for easy storage.',
        price_cents: 1600,
        compare_price_cents: 2499,
        image_url: 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=800&q=80']),
        category: 'cats',
        tags: JSON.stringify(['play', 'hide', 'exercise']),
        featured: true,
        sort_order: 5
      },
      {
        name: 'Stainless Steel Dog Bowl Set',
        slug: 'stainless-steel-dog-bowl-set',
        description: 'Two heavy-duty stainless steel bowls — one for food, one for water — with a non-slip silicone base that stays put even for the most enthusiastic eaters. Dishwasher safe. Won\'t harbor bacteria like plastic bowls.',
        price_cents: 1500,
        compare_price_cents: 2299,
        image_url: 'https://images.unsplash.com/photo-1534361960057-19f4434c5fa8?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1534361960057-19f4434c5fa8?w=800&q=80']),
        category: 'dogs',
        tags: JSON.stringify(['feeding', 'water', 'durable']),
        featured: false,
        sort_order: 6
      },
      {
        name: 'Feather Wand Cat Toy',
        slug: 'feather-wand-cat-toy',
        description: 'The classic cat toy, upgraded. Extra-long wand (24 inches!) with a replaceable feather attachment that mimics real bird movement. Inspires your cat\'s natural hunting instincts. Comes with 2 bonus feather attachments.',
        price_cents: 1000,
        compare_price_cents: 1699,
        image_url: 'https://images.unsplash.com/photo-1518791841217-8f162f1912da?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1518791841217-8f162f1912da?w=800&q=80']),
        category: 'cats',
        tags: JSON.stringify(['wand', 'feather', 'interactive']),
        featured: false,
        sort_order: 7
      },
      {
        name: 'Dog Treat Training Pouch',
        slug: 'dog-treat-training-pouch',
        description: 'Never fumble for treats during training again. This magnetic-close treat pouch clips to your belt or waistband and holds a full bag of kibble. Built-in poop bag dispenser, key ring, and waterproof lining. Every dog trainer\'s secret weapon.',
        price_cents: 1600,
        compare_price_cents: 2299,
        image_url: 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=800&q=80']),
        category: 'dogs',
        tags: JSON.stringify(['training', 'treats', 'walking']),
        featured: false,
        sort_order: 8
      },
      {
        name: 'No-Pull Dog Harness',
        slug: 'no-pull-dog-harness',
        description: 'Stop the yanking, save your shoulders. This padded mesh harness has a front clip that redirects pulling dogs back toward you — no pain, no choke. Reflective stitching for night walks. Adjustable across chest, belly, and neck. Sizes S-XL.',
        price_cents: 2200,
        compare_price_cents: 3599,
        image_url: 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=800&q=80']),
        category: 'dogs',
        tags: JSON.stringify(['harness', 'walking', 'no-pull']),
        featured: true,
        sort_order: 9
      },
      {
        name: 'Sisal Cat Scratching Post',
        slug: 'sisal-cat-scratching-post',
        description: 'Save your couch. This 28-inch natural sisal post gives cats a legit place to scratch, stretch, and sharpen their claws. Weighted base won\'t tip over. Topped with a dangling pom-pom toy. Much less expensive than new furniture.',
        price_cents: 2500,
        compare_price_cents: 3999,
        image_url: 'https://images.unsplash.com/photo-1513360371669-4adf3dd7dff8?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1513360371669-4adf3dd7dff8?w=800&q=80']),
        category: 'cats',
        tags: JSON.stringify(['scratching', 'furniture-protection', 'sisal']),
        featured: true,
        sort_order: 10
      },
      {
        name: 'Silent Exercise Wheel for Small Pets',
        slug: 'small-pet-exercise-wheel',
        description: 'The midnight zoomies are real — and now they can be silent. This 8.5-inch wheel runs on ball bearings so smoothly you\'ll forget it exists. Solid running surface protects tiny feet. Fits hamsters, gerbils, and small mice perfectly.',
        price_cents: 1800,
        compare_price_cents: 2799,
        image_url: 'https://images.unsplash.com/photo-1548681528-6a5c45b66b42?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1548681528-6a5c45b66b42?w=800&q=80']),
        category: 'small-pets',
        tags: JSON.stringify(['hamster', 'gerbil', 'exercise', 'silent']),
        featured: false,
        sort_order: 11
      },
      {
        name: 'Cozy Hideout House for Small Pets',
        slug: 'small-pet-hideout-house',
        description: 'Every small pet needs a safe cozy burrow. This wooden hideout has multiple entry points, a smooth interior, and chew-safe wood finish. Perfect for hamsters, mice, gerbils, and dwarf rabbits. Doubles as a platform for climbing.',
        price_cents: 1200,
        compare_price_cents: 1999,
        image_url: 'https://images.unsplash.com/photo-1548681528-6a5c45b66b42?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1548681528-6a5c45b66b42?w=800&q=80']),
        category: 'small-pets',
        tags: JSON.stringify(['hamster', 'hideout', 'wooden']),
        featured: false,
        sort_order: 12
      },
      {
        name: 'Bird Cage Enrichment Bundle',
        slug: 'bird-cage-enrichment-bundle',
        description: 'Keep your feathered friend busy, happy, and mentally sharp. This 5-piece bundle includes colorful swings, foraging toys, rope perch, bell toy, and a mirror. Compatible with most standard-sized cages. Safe, bird-grade materials throughout.',
        price_cents: 1400,
        compare_price_cents: 2299,
        image_url: 'https://images.unsplash.com/photo-1444464666168-49d633b86797?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1444464666168-49d633b86797?w=800&q=80']),
        category: 'small-pets',
        tags: JSON.stringify(['bird', 'parrot', 'cage', 'enrichment']),
        featured: false,
        sort_order: 13
      },
      {
        name: 'Dog Bandana Set (3-Pack)',
        slug: 'dog-bandana-set',
        description: 'Because your dog deserves to be the most fashionable pup at the park. Set of 3 stylish bandanas in fun patterns — snap closure fits all neck sizes from chihuahuas to Great Danes. 100% soft cotton. Machine washable. Heads will turn.',
        price_cents: 1200,
        compare_price_cents: 1899,
        image_url: 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=800&q=80']),
        category: 'accessories',
        tags: JSON.stringify(['fashion', 'bandana', 'dog-accessories']),
        featured: true,
        sort_order: 14
      },
      {
        name: 'Breakaway Cat Collar with Bell',
        slug: 'cat-collar-with-bell',
        description: 'Cute AND safe. This breakaway collar releases under pressure so your cat won\'t get snagged. Soft adjustable neoprene band with a bright ID tag D-ring and gentle warning bell. Available in 6 colors. Fits necks 7–11 inches.',
        price_cents: 1000,
        compare_price_cents: 1699,
        image_url: 'https://images.unsplash.com/photo-1596854407944-bf87f6fdd49e?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1596854407944-bf87f6fdd49e?w=800&q=80']),
        category: 'accessories',
        tags: JSON.stringify(['collar', 'cat', 'safety', 'breakaway']),
        featured: false,
        sort_order: 15
      },
      {
        name: 'Self-Cleaning Pet Grooming Brush',
        slug: 'self-cleaning-grooming-brush',
        description: 'One button, all the fur. This slicker brush has stainless steel pins that remove loose fur, mats, and tangles painlessly — then press the button and the pins retract, dropping the fur right into the trash. Works on dogs and cats of all coat types.',
        price_cents: 1800,
        compare_price_cents: 2799,
        image_url: 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=800&q=80']),
        category: 'accessories',
        tags: JSON.stringify(['grooming', 'brush', 'shedding']),
        featured: false,
        sort_order: 16
      },
      {
        name: 'Organic Paw Balm',
        slug: 'organic-paw-balm',
        description: 'Cracked, dry paws? Not on our watch. This beeswax-based balm soothes and protects with shea butter, vitamin E, and coconut oil — all pet-safe, all natural. Works on paws, noses, and elbows. Non-greasy, fast-absorbing, and lick-safe.',
        price_cents: 1200,
        compare_price_cents: 1999,
        image_url: 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=600&q=80',
        images: JSON.stringify(['https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=800&q=80']),
        category: 'accessories',
        tags: JSON.stringify(['grooming', 'paw-care', 'organic', 'lick-safe']),
        featured: false,
        sort_order: 17
      }
    ];

    for (const p of products) {
      await client.query(`
        INSERT INTO pet_products (name, slug, description, price_cents, compare_price_cents, image_url, images, category, tags, featured, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11)
        ON CONFLICT (slug) DO NOTHING
      `, [p.name, p.slug, p.description, p.price_cents, p.compare_price_cents, p.image_url, p.images, p.category, p.tags, p.featured, p.sort_order]);
    }
  }
};

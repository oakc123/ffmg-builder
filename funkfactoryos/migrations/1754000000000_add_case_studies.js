// Migration: case_studies table for /work portfolio hub. Slug uniqueness
// also backs the /work/:slug detail route. Seed inserts are preflighted by
// slug so a partially-applied migration can re-run safely without tripping
// the unique index.
const SEEDS = [
  {
    slug: 'sunshine-theater-concert-film',
    title: 'Summer Night Series — Multi-Camera Concert Coverage',
    client: 'Sunshine Theater',
    service_tags: ['Concert Videography', 'Event Coverage'],
    cover_image_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_72576/4c846834-b7ba-434b-b1dc-bf9669458ead.jpg',
    summary: 'Six consecutive concert nights, each shot with two cameras from floor and balcony. 48-hour recap clips plus a full series highlight reel for venue booking outreach.',
    display_order: 10
  },
  {
    slug: 'rrhs-football-season-coverage',
    title: 'Varsity Football — Full Season Sideline Coverage',
    client: 'Rio Rancho High School',
    service_tags: ['Sports Photography', 'Event Coverage'],
    cover_image_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_72576/e7428df1-6525-4189-8efe-37675650b83f.jpg',
    summary: 'Full sideline access for eight home games. Edited gallery delivered every Sunday morning — ready for coaches, players, booster clubs, and school social accounts.',
    display_order: 20
  },
  {
    slug: 'local-artist-content-package',
    title: '12-Week Content Package — Weekly Reels & TikTok',
    client: 'Local Artist',
    service_tags: ['Social Media Content', 'Photography'],
    cover_image_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_72576/acc3a499-7907-47df-a252-e0cabe2741cd.jpg',
    summary: 'One shoot day per month produced four weeks of platform-native content: weekly Reels, TikTok clips, and story sequences — handed off scheduled and ready to post.',
    display_order: 30
  },
  {
    slug: 'rattlesnake-bar-brand-film',
    title: 'Venue Brand Film — Atmosphere, Regulars & Live Nights',
    client: 'Rattlesnake Bar',
    service_tags: ['Brand Film', 'Concert Videography'],
    cover_image_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_72576/e8d10b34-f6a7-41a0-bf27-5f5e76e64b1c.jpg',
    summary: 'A cinematic 2-minute brand film capturing energy, regulars, and live music nights — used on the homepage, in booking decks, and as the lead piece for an Instagram relaunch.',
    display_order: 40
  },
  {
    slug: 'venue-web-design',
    title: 'Full-Service Venue Website — Booking, Gallery & Events',
    client: 'Venue Client',
    service_tags: ['Web Design'],
    cover_image_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_72576/d5f7c9a1-1ebd-43ab-9411-f0485229977c.jpg',
    summary: '10-page responsive site built from scratch: hero video header, events calendar with ticketing links, artist gallery, booking inquiry form, and embedded social feed.',
    display_order: 50
  },
  {
    slug: 'sports-social-highlights',
    title: 'Weekly Sports Highlights — Sideline to Social',
    client: 'New Mexico Athletic League',
    service_tags: ['Social Media Content', 'Sports Photography'],
    cover_image_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_72576/034845bd-137f-4e0c-93d9-8efdbf251dac.jpg',
    summary: 'Sideline stills and short-form clips from weekly matchups packaged into ready-to-post Instagram carousels, TikTok cuts, and game-day story sequences.',
    display_order: 60
  }
];

module.exports = {
  name: 'add_case_studies',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS case_studies (
        id SERIAL PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        client TEXT NOT NULL,
        service_tags TEXT[] NOT NULL DEFAULT '{}',
        cover_image_url TEXT NOT NULL,
        summary TEXT,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS case_studies_slug_unique_idx ON case_studies (slug)`);
    await client.query(`CREATE INDEX IF NOT EXISTS case_studies_display_order_idx ON case_studies (display_order ASC, id ASC)`);

    for (const seed of SEEDS) {
      // Skip-if-already-present so a failed migration that left the table
      // behind can safely re-run without unique-constraint errors.
      const existing = await client.query('SELECT id FROM case_studies WHERE slug = $1', [seed.slug]);
      if (existing.rows.length > 0) continue;
      await client.query(
        `INSERT INTO case_studies (slug, title, client, service_tags, cover_image_url, summary, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [seed.slug, seed.title, seed.client, seed.service_tags, seed.cover_image_url, seed.summary, seed.display_order]
      );
    }
  }
};

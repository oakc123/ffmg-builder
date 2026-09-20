// Migration: case_studies.narrative JSONB column for the /work/:slug detail
// route. narrative holds { challenge, approach, results } so the three
// sections render server-side. Seed inserts are preflighted by slug + an
// `'{}'::jsonb` guard so a re-run won't clobber copy edited in the database.
const NARRATIVE_SEEDS = [
  {
    slug: 'sunshine-theater-concert-film',
    narrative: {
      challenge: 'Sunshine Theater booked six back-to-back headliners across two weekends and needed recap social content ready before doors opened on the next show — while still capturing the full arc of the run for booking outreach with out-of-state promoters.',
      approach: 'We ran a two-camera package each night, locking each show from the balcony and the floor so edits could cut between crowd energy and stage performance. Recap clips were cut and approved within 48 hours of each show, and the full six-night run was then cut down into a single series-reel for booking decks.',
      results: 'Every recap clip shipped inside the 48-hour window, the venue landed two out-of-state booking inquiries off the series reel, and the package now anchors Sunshine Theater\'s ongoing social cadence.'
    }
  },
  {
    slug: 'rrhs-football-season-coverage',
    narrative: {
      challenge: 'Rio Rancho High School wanted consistent sideline coverage for eight home games that coaches, players, booster clubs, and the school\'s social accounts could all pull from — without demanding marketing hours from existing staff.',
      approach: 'We embedded a dedicated sideline shooter for every home game and turned around edited galleries by Sunday morning so each audience had fresh imagery before the next week of school. Shots were organized in shared galleries with sport-specific naming so the booster club could grab prints independently.',
      results: 'Coaches used the stills in recruiting materials, the booster club sold out the team banquet photo packages, and the school\'s social accounts ran a year-in-review carousel built entirely from the season gallery.'
    }
  },
  {
    slug: 'local-artist-content-package',
    narrative: {
      challenge: 'A local artist needed a steady drumbeat of platform-native content for Reels and TikTok without having to clear a shoot-day from their songwriting schedule every week.',
      approach: 'We structured the engagement as one shoot day per month, producing a month\'s worth of weekly Reels, TikTok clips, and story sequences — all pre-edited, captioned, and queued for scheduled posting so the artist only had to show up to the shoot.',
      results: 'The package ran for twelve consecutive weeks, the artist\'s Reels views tripled over the engagement, and the format is now a standing monthly retainer heading into their next release cycle.'
    }
  },
  {
    slug: 'rattlesnake-bar-brand-film',
    narrative: {
      challenge: 'Rattlesnake Bar needed a brand film that captured the energy of a regular-night at the bar — not a staged commercial — so it could anchor upcoming booking decks and relaunch the venue\'s Instagram presence.',
      approach: 'We shot during a real live night, roving between regulars, the bartenders, and the band, then cut a two-minute cinematic piece centered on atmosphere rather than hard-sell. The film was structured so the venue could drop shorter cut-downs for individual social posts.',
      results: 'The two-minute film runs on the venue homepage, anchors the relaunched Instagram grid, and has been used by three booking agents pitching out-of-state acts into the Rattlesnake calendar.'
    }
  },
  {
    slug: 'venue-web-design',
    narrative: {
      challenge: 'A live-music venue wanted a website that handled hero video, an upcoming-events calendar with ticketing, an artist gallery, and a booking inquiry form — without forcing staff to learn a CMS or wait on an agency retainer for routine updates.',
      approach: 'We built a ten-page responsive site with a hero video header, an events calendar wired into the venue\'s existing ticketing links, a curated artist gallery, and a lightweight booking form that drops inquiries straight into the venue\'s inbox. We also recorded a short handover video so staff could update the calendar without calling us.',
      results: 'The venue\'s online ticket revenue for the first month after launch was more than double the prior period, the booking form cut inbound email back-and-forth in half, and staff have shipped routine updates themselves since the site went live.'
    }
  },
  {
    slug: 'sports-social-highlights',
    narrative: {
      challenge: 'The New Mexico Athletic League needed weekly social highlight packages across multiple matchups — sideline stills, short-form clips, and game-day story assets — without tying up athletic-department staff on editing.',
      approach: 'We packaged each week\'s matchups into a single shoot-day, then turned the raw sideline stills and clips into Instagram carousels, TikTok cuts, and game-day story sequences that dropped straight into the League\'s queue with minimal back-and-forth with League comms.',
      results: 'Weekly packages shipped on schedule across the full season, the League\'s Instagram follower count grew steadily without paid spend, and the format now serves as the standing highlight cadence the League uses every season.'
    }
  }
];

module.exports = {
  name: 'add_case_studies_narrative',
  up: async (client) => {
    await client.query(`ALTER TABLE case_studies ADD COLUMN IF NOT EXISTS narrative JSONB NOT NULL DEFAULT '{}'::jsonb`);

    for (const seed of NARRATIVE_SEEDS) {
      // Skip-if-already-present so a re-run won't clobber narrative copy edited
      // directly in the database. Mirrors the guard in 1754000000000_add_case_studies.js.
      const existing = await client.query('SELECT narrative FROM case_studies WHERE slug = $1', [seed.slug]);
      if (existing.rows.length === 0) continue;
      const current = existing.rows[0].narrative;
      const isUnset = !current || (typeof current === 'object' && Object.keys(current).length === 0);
      if (!isUnset) continue;
      await client.query(
        'UPDATE case_studies SET narrative = $1::jsonb WHERE slug = $2',
        [JSON.stringify(seed.narrative), seed.slug]
      );
    }
  }
};

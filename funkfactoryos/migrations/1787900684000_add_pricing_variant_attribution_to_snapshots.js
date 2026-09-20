module.exports = {
  name: 'add_pricing_variant_attribution_to_snapshots',
  up: async (client) => {
    await client.query(`
      ALTER TABLE attribution_snapshots
        ADD COLUMN IF NOT EXISTS pricing_variants JSONB
    `);

    const admin = require('../db/admin');
    const pricingVariants = await admin.getPricingVariantSourceAttribution({ days: 30 });

    await client.query({
      text: `
        UPDATE attribution_snapshots
        SET pricing_variants = $1::jsonb
        WHERE is_baseline = TRUE
          AND pricing_variants IS NULL
      `,
      values: [JSON.stringify(pricingVariants)]
    });
  }
};

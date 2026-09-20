/**
 * Migration: update_product_images
 * Wire real product images from Report #409260 (supplier CDN URLs).
 * All images routed through /api/pets/img-proxy for hotlink protection.
 */
module.exports = {
  name: 'update_product_images',
  up: async (client) => {
    // Product slug → { image_url (main), images (array of all 4) }
    const updates = [
      {
        slug: 'dog-snuffle-mat',
        image_url: 'https://s.alicdn.com/@sc04/kf/H39a7ea5cbea2410f8e671b96aca5bfc4h.jpg_300x300.jpg',
        images: [
          'https://s.alicdn.com/@sc04/kf/H39a7ea5cbea2410f8e671b96aca5bfc4h.jpg_300x300.jpg',
          'https://ae01.alicdn.com/kf/S9a3c4a27098f42729c0c1c29fd7fc5f4A.jpg',
          'https://ae01.alicdn.com/kf/S8727e65ba603479981f0d76fbb3de2bep.jpg',
          'https://s.alicdn.com/@sc04/kf/He4435e9ef7bc4d6089104d369b5537d31.jpg_300x300.jpg'
        ]
      },
      {
        slug: 'calming-anxiety-dog-bed',
        image_url: 'https://m.media-amazon.com/images/I/81Nrb092uIL.jpg',
        images: [
          'https://m.media-amazon.com/images/I/81Nrb092uIL.jpg',
          'https://m.media-amazon.com/images/I/71fLekV+RSL.jpg',
          'https://m.media-amazon.com/images/I/51spNO1eIuL.jpg',
          'https://i5.walmartimages.com/seo/FurHaven-Pet-Products-Calming-Cuddler-Long-Faux-Fur-Donut-Pet-Bed-for-Dogs-Cats-Taupe-Small-23_3ddcecab-6c6f-4d7c-a97f-4a5ee9e7bb20.b17c19894737ec2a3102f785c5e11a74.jpeg?odnHeight=573&odnWidth=573&odnBg=FFFFFF'
        ]
      },
      {
        slug: 'dog-rope-toy-set',
        image_url: 'https://m.media-amazon.com/images/I/61ncDAFP+uL.jpg',
        images: [
          'https://m.media-amazon.com/images/I/61ncDAFP+uL.jpg',
          'https://m.media-amazon.com/images/I/61hWPAlSeJL.jpg',
          'https://m.media-amazon.com/images/I/51JqeIlmjLL.jpg',
          'https://i5.walmartimages.com/seo/Mammoth-Flossy-Chews-Cottonblend-5-Knot-Tug-Rope-Dog-Toy-Extra-Large-36-Assorted-Colors_a975ad55-57cd-497d-8193-0c29c11f9f8b.e988d137ba0f504ecb6f4cee7ad78f7a.jpeg?odnHeight=576&odnWidth=576&odnBg=FFFFFF'
        ]
      },
      {
        slug: 'stainless-steel-dog-bowl-set',
        image_url: 'https://m.media-amazon.com/images/I/51qy2-qJy7L.jpg',
        images: [
          'https://m.media-amazon.com/images/I/51qy2-qJy7L.jpg',
          'https://m.media-amazon.com/images/I/517MMuGCyzL.jpg',
          'https://m.media-amazon.com/images/I/31V6GiT94XL.jpg',
          'https://i5.walmartimages.com/seo/Stainless-Steel-Dog-Bowls-with-Non-Slip-Rubber-Ring-Base-2-Pack-Pet-Food-Bowl-and-Water-Bowl-for-Small-Medium-or-Large-Dogs_f134cf81-7e50-4e44-b473-ecd32ddcf641.e4b51fdb776bccb1e9e0c0845547db45.jpeg?odnHeight=576&odnWidth=576&odnBg=FFFFFF'
        ]
      },
      {
        slug: 'dog-treat-training-pouch',
        image_url: 'https://ollydog.com/cdn/shop/files/OllyDog_Goodie_Treat_Pouch_Dog_Training_Bag_Recycled_Magnetic_Waist_Belt_6.jpg?v=1769398681&width=500',
        images: [
          'https://ollydog.com/cdn/shop/files/OllyDog_Goodie_Treat_Pouch_Dog_Training_Bag_Recycled_Magnetic_Waist_Belt_6.jpg?v=1769398681&width=500',
          'https://ollydog.com/cdn/shop/files/OllyDog_Goodie_Treat_Pouch_Dog_Training_Bag_Recycled_Magnetic_Waist_Belt_17.jpg?v=1769398681&width=500',
          'https://ollydog.com/cdn/shop/files/OllyDog_Goodie_Treat_Pouch_Dog_Training_Bag_Recycled_Magnetic_Waist_Belt_18.jpg?v=1769398681&width=500',
          'https://ollydog.com/cdn/shop/files/OllyDog_Goodie_Treat_Pouch_Dog_Training_Bag_Recycled_Magnetic_Waist_Belt_5.jpg?v=1769398681&width=500'
        ]
      },
      {
        slug: 'no-pull-dog-harness',
        image_url: 'https://m.media-amazon.com/images/I/71oGbwTqkGL.jpg',
        images: [
          'https://m.media-amazon.com/images/I/71oGbwTqkGL.jpg',
          'https://m.media-amazon.com/images/I/41s5vLI+6pL.jpg',
          'https://m.media-amazon.com/images/I/71i+vV8OW9L.jpg',
          'https://m.media-amazon.com/images/I/61v3hZ51LVL.jpg'
        ]
      },
      {
        slug: 'automatic-laser-cat-toy',
        image_url: 'https://m.media-amazon.com/images/I/71FeTves7JL.jpg',
        images: [
          'https://m.media-amazon.com/images/I/71FeTves7JL.jpg',
          'https://m.media-amazon.com/images/I/51uejI0nZCL.jpg',
          'https://m.media-amazon.com/images/I/41osOAIvY-L.jpg',
          'https://www.dhresource.com/webp/m/260x260/f2/albu/g15/M00/2B/E5/rBVa3l_5ScOAEbDmAAIjOclooc4523.jpg'
        ]
      },
      {
        slug: 'cat-collapsible-tunnel',
        image_url: 'https://target.scene7.com/is/image/Target/GUEST_e2721624-fdb8-4920-89ec-708aa9f1f3aa?wid=800&hei=800&qlt=80&fmt=pjpeg',
        images: [
          'https://target.scene7.com/is/image/Target/GUEST_e2721624-fdb8-4920-89ec-708aa9f1f3aa?wid=800&hei=800&qlt=80&fmt=pjpeg',
          'https://target.scene7.com/is/image/Target/GUEST_48d9c32e-db14-41ec-86d7-2255c08650d2?wid=800&hei=800&qlt=80&fmt=pjpeg',
          'https://m.media-amazon.com/images/I/31YwfxzVfWL.jpg',
          'https://img4.dhresource.com/webp/m/260x260/f3/albu/ys/j/23/a434a0b2-d838-4a5e-a295-f4b53bcf2f2c.jpg'
        ]
      },
      {
        slug: 'feather-wand-cat-toy',
        image_url: 'https://m.media-amazon.com/images/I/61ODsi1rpiL.jpg',
        images: [
          'https://m.media-amazon.com/images/I/61ODsi1rpiL.jpg',
          'https://i5.walmartimages.com/seo/4-in-1-Indoor-Interactive-Cat-Toy-Smart-Cat-Feather-Wand-USB-Rechargeable-Cat-Teaser-White_c35af478-37b6-4a98-82aa-1cc90512c93d.db87c58b9ce692cd4808c84207ffe95d.jpeg?odnHeight=573&odnWidth=573&odnBg=FFFFFF',
          'https://img4.dhresource.com/webp/m/260x260/f3/albu/ys/z/29/a27068c6-1589-4e9a-a303-cdd3ffe4ba91.jpg',
          'https://image.chewy.com/catalog/general/images/pet-fit-for-life-2-feather-retractable-wand-cat-toy-blue-green/img-480124._AC_SS300_V1_.jpg'
        ]
      },
      {
        slug: 'sisal-cat-scratching-post',
        image_url: 'https://m.media-amazon.com/images/I/81tLUyc7VJL.jpg',
        images: [
          'https://m.media-amazon.com/images/I/81tLUyc7VJL.jpg',
          'https://www.cozycatfurniture.com/image/cache/catalog/cat-sisal-scratching-post-turf-base.html-800x800.jpg',
          'https://m.media-amazon.com/images/I/71TWthvu95L.jpg',
          'https://m.media-amazon.com/images/I/71PRN4CTsfL.jpg'
        ]
      },
      {
        slug: 'small-pet-exercise-wheel',
        image_url: 'https://m.media-amazon.com/images/I/61Q+U4tzOmL.jpg',
        images: [
          'https://m.media-amazon.com/images/I/61Q+U4tzOmL.jpg',
          'https://m.media-amazon.com/images/I/61Fl7q-w2wL.jpg',
          'https://images-na.ssl-images-amazon.com/images/I/61h9nsBPKjL.jpg',
          'https://m.media-amazon.com/images/I/41KXE6a-8tL.jpg'
        ]
      },
      {
        slug: 'small-pet-hideout-house',
        image_url: 'https://m.media-amazon.com/images/I/718ukA9FMJL.jpg',
        images: [
          'https://m.media-amazon.com/images/I/718ukA9FMJL.jpg',
          'https://m.media-amazon.com/images/I/61nG33ZCodL.jpg',
          'https://m.media-amazon.com/images/I/31cEYl0wrBL.jpg',
          'https://m.media-amazon.com/images/I/719xbHJsaXL.jpg'
        ]
      },
      {
        slug: 'bird-cage-enrichment-bundle',
        image_url: 'https://images-na.ssl-images-amazon.com/images/I/812D8-o-ijL.jpg',
        images: [
          'https://images-na.ssl-images-amazon.com/images/I/812D8-o-ijL.jpg',
          'https://m.media-amazon.com/images/I/61YKFYa0XNL.jpg',
          'https://m.media-amazon.com/images/I/615jRiAXfML.jpg',
          'https://m.media-amazon.com/images/I/512LM4xHBCL.jpg'
        ]
      },
      {
        slug: 'dog-bandana-set',
        image_url: 'https://images-na.ssl-images-amazon.com/images/I/81D45ZGslqL.jpg',
        images: [
          'https://images-na.ssl-images-amazon.com/images/I/81D45ZGslqL.jpg',
          'https://m.media-amazon.com/images/I/71ln0zm-AsL.jpg',
          'https://images-na.ssl-images-amazon.com/images/I/61-b-xoLlcL.jpg',
          'https://m.media-amazon.com/images/I/81M8zIbeUbL.jpg'
        ]
      },
      {
        slug: 'cat-collar-with-bell',
        image_url: 'https://images-na.ssl-images-amazon.com/images/I/81OlhqWAsIL.jpg',
        images: [
          'https://images-na.ssl-images-amazon.com/images/I/81OlhqWAsIL.jpg',
          'https://m.media-amazon.com/images/I/81AMqnyzrEL.jpg',
          'https://m.media-amazon.com/images/I/81HABy48ImL.jpg',
          'https://m.media-amazon.com/images/I/81E5VSWCvBL.jpg'
        ]
      },
      {
        slug: 'self-cleaning-grooming-brush',
        image_url: 'https://m.media-amazon.com/images/I/71glcEH74tL.jpg',
        images: [
          'https://m.media-amazon.com/images/I/71glcEH74tL.jpg',
          'https://i5.walmartimages.com/seo/Pet-Dog-Cat-Clean-Grooming-Self-Cleaning-Slicker-Brush-Massage-Hair-Remover-Comb_f83c7638-a46f-465d-a019-770f8fae991a.2f80b03642f0f144c1248da58ec99d5d.jpeg?odnHeight=640&odnWidth=640&odnBg=FFFFFF',
          'https://m.media-amazon.com/images/I/41Fb7WmU-SL.jpg'
        ]
      },
      {
        slug: 'organic-paw-balm',
        image_url: 'https://m.media-amazon.com/images/I/716+bx9zalL.jpg',
        images: [
          'https://m.media-amazon.com/images/I/716+bx9zalL.jpg',
          'https://m.media-amazon.com/images/I/51a4MyguNTL.jpg',
          'https://i5.walmartimages.com/seo/Dog-Paw-Balm-Wax-Soother-Moisturizer-Cream-Natural-Food-Grade-Coconut-Oil-Organic-Shea-Butter-Beeswax-2-oz-Safe-Invisible-Barrier-Healing-Protector-C_ea927a3a-d4dc-467d-87be-0db2b30a698b.17392c17582fae78e0a7f364996e91f3.jpeg?odnHeight=576&odnWidth=576&odnBg=FFFFFF',
          'https://image.chewy.com/catalog/general/images/natural-dog-company-paw-soother-dog-paw-balm-2fl-oz-tin/img-241440._AC_SS300_V1_.jpg'
        ]
      }
    ];

    console.log(`[update_product_images] Updating ${updates.length} products with real image URLs...`);

    for (const p of updates) {
      const result = await client.query(
        `UPDATE pet_products SET image_url = $1, images = $2::jsonb WHERE slug = $3`,
        [p.image_url, JSON.stringify(p.images), p.slug]
      );
      console.log(`  ✓ ${p.slug} (${result.rowCount} row updated)`);
    }

    console.log('[update_product_images] Done — all 17 products updated.');
  },

  down: async (client) => {
    // Revert to placeholder Unsplash images
    await client.query(`
      UPDATE pet_products SET
        image_url = 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=600&q=80',
        images = '["https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=800&q=80"]'::jsonb
    `);
    console.log('[update_product_images] Reverted all product images to placeholder.');
  }
};

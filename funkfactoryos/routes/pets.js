// Owns: Funk Factory Pets e-commerce — products, checkout, orders, SEO pages, image proxy
// Does NOT own: FFMG booking/contact, admin auth, analytics tracking
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const pool = require('../db');

// Simple in-memory image proxy cache: url → { contentType, buffer, ts }
const imgCache = new Map();
const IMG_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── EMAIL HELPER ─────────────────────────────────────────────────────────────
// Sends new order notification to owner; tries Polsia proxy → SMTP → console log
const fetch = require('node-fetch');

async function sendOrderEmail(order, items) {
  const ownerEmail = process.env.OWNER_EMAIL || 'amer.child@funkfactorymediagroup.com';
  const addr = order.shipping_address || {};
  const addrLine = [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country]
    .filter(Boolean).join(', ');

  const itemsList = items.map(i =>
    `  • ${i.product_name} x${i.quantity}  —  $${(i.unit_price_cents / 100).toFixed(2)}`
  ).join('\n');

  const subject = `🐾 New Order #${order.id} — $${(order.total_cents / 100).toFixed(2)} — Funk Factory Pets`;
  const body = `New order received on Funk Factory Pets!\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `ORDER #${order.id}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `ITEMS:\n${itemsList}\n\n` +
    `Subtotal:  $${(order.subtotal_cents / 100).toFixed(2)}\n` +
    `Shipping:  $${(order.shipping_cents / 100).toFixed(2)}\n` +
    `TOTAL:     $${(order.total_cents / 100).toFixed(2)}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `CUSTOMER + SHIP TO (copy into CJ Dropshipping CJ5327243):\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Name:    ${order.name || order.email}\n` +
    `Email:   ${order.email}\n` +
    `Address: ${addrLine || '(not captured yet)'}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Manage orders: https://funkfactoryos.polsia.app/admin/orders\n`;

  const polsiaKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const polsiaBase = (process.env.POLSIA_R2_BASE_URL || 'https://polsia.com').replace(/\/$/, '');
  const emailPayload = { to: ownerEmail, subject, text: body, from: 'orders@polsia.app' };

  if (polsiaKey) {
    const candidates = ['/api/email/send', '/api/company/email/send', '/email/send'];
    for (const ep of candidates) {
      try {
        const r = await fetch(`${polsiaBase}${ep}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': polsiaKey, 'Authorization': `Bearer ${polsiaKey}` },
          body: JSON.stringify(emailPayload)
        });
        if (r.ok) {
          const data = await r.json().catch(() => ({}));
          if (data.success || data.id || data.messageId) {
            console.log(`[Orders] Email sent via Polsia proxy (${ep}) for order #${order.id}`);
            return;
          }
        }
      } catch { /* try next */ }
    }
  }

  const smtpHost = process.env.SMTP_HOST;
  if (smtpHost) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: ownerEmail,
        subject,
        text: body
      });
      console.log(`[Orders] Email sent via SMTP for order #${order.id}`);
      return;
    } catch (err) {
      console.error('[Orders] SMTP failed:', err.message);
    }
  }

  console.log(`[Orders] ═══════════ ORDER NOTIFICATION ═══════════`);
  console.log(`[Orders] TO: ${ownerEmail}`);
  console.log(`[Orders] SUBJECT: ${subject}`);
  console.log(`[Orders] ${body}`);
  console.log(`[Orders] ════════════════════════════════════════════`);
}

// ── IMAGE PROXY ───────────────────────────────────────────────────────────────
router.get('/img-proxy', (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).end();

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    new URL(targetUrl); // validate
  } catch {
    return res.status(400).end();
  }

  const cached = imgCache.get(targetUrl);
  if (cached && (Date.now() - cached.ts < IMG_CACHE_TTL)) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Cache', 'HIT');
    return res.end(cached.buffer);
  }

  const mod = targetUrl.startsWith('https') ? https : http;
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/webp,image/avif,image/*,*/*;q=0.8',
      'Referer': 'https://www.google.com/',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  };

  const proxyReq = mod.get(targetUrl, options, (proxyRes) => {
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      proxyRes.resume();
      const redirect = proxyRes.headers.location.startsWith('http')
        ? proxyRes.headers.location
        : new URL(proxyRes.headers.location, targetUrl).href;
      return res.redirect(`/api/pets/img-proxy?url=${encodeURIComponent(redirect)}`);
    }
    if (proxyRes.statusCode !== 200) {
      proxyRes.resume();
      return res.status(proxyRes.statusCode || 502).end();
    }
    const contentType = proxyRes.headers['content-type'] || 'image/jpeg';
    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (imgCache.size > 200) {
        const firstKey = imgCache.keys().next().value;
        imgCache.delete(firstKey);
      }
      imgCache.set(targetUrl, { contentType, buffer, ts: Date.now() });
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Cache', 'MISS');
      res.end(buffer);
    });
  });

  proxyReq.on('error', (err) => {
    console.error('[ImgProxy] Error:', err.message, targetUrl.substring(0, 80));
    if (!res.headersSent) res.status(502).end();
  });
  proxyReq.setTimeout(8000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).end();
  });
});

// ── PRODUCT API ───────────────────────────────────────────────────────────────
router.get('/products', async (req, res) => {
  try {
    const { category, featured, limit = 100 } = req.query;
    const params = [];
    const conditions = [];
    let idx = 1;
    if (category && category !== 'all') { conditions.push(`category = $${idx++}`); params.push(category); }
    if (featured === 'true') { conditions.push(`featured = true`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')} AND in_stock = true` : 'WHERE in_stock = true';
    params.push(parseInt(limit) || 100);
    const result = await pool.query(
      `SELECT id, name, slug, description, price_cents, compare_price_cents, image_url, images, category, tags, featured, sort_order
       FROM pet_products ${where}
       ORDER BY sort_order ASC, id ASC
       LIMIT $${idx}`,
      params
    );
    res.json({ success: true, products: result.rows });
  } catch (err) {
    console.error('[Pets] Error fetching products:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/products/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const result = await pool.query(
      `SELECT id, name, slug, description, price_cents, compare_price_cents, image_url, images, category, tags, featured
       FROM pet_products WHERE slug = $1 AND in_stock = true`,
      [slug]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error('[Pets] Error fetching product:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/products-by-ids', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.json({ success: true, products: [] });
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(
      `SELECT id, name, slug, price_cents, compare_price_cents, image_url, category FROM pet_products WHERE id IN (${placeholders}) AND in_stock = true`,
      ids
    );
    res.json({ success: true, products: result.rows });
  } catch (err) {
    console.error('[Pets] Error fetching products by ids:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── CHECKOUT ──────────────────────────────────────────────────────────────────
// PETS_DOMAIN exposed to this module via env or hardcode — same value as server.js
const PETS_DOMAIN = 'funkfactorypets.com';

router.post('/checkout', async (req, res) => {
  try {
    const { items, email } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ success: false, message: 'Cart is empty' });
    }

    const productIds = items.map(i => i.product_id);
    const placeholders = productIds.map((_, i) => `$${i + 1}`).join(',');
    const productResult = await pool.query(
      `SELECT id, name, slug, price_cents, image_url FROM pet_products WHERE id IN (${placeholders}) AND in_stock = true`,
      productIds
    );
    const productMap = {};
    productResult.rows.forEach(p => { productMap[p.id] = p; });

    for (const item of items) {
      if (!productMap[item.product_id]) {
        return res.status(400).json({ success: false, message: `Product ${item.product_id} not found or out of stock` });
      }
    }

    const origin = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const reqHost = (req.headers.host || '').replace(/^www\./, '').replace(/:\d+$/, '');
    const isPetsDomain = reqHost.toLowerCase() === PETS_DOMAIN;
    const petsPrefix = isPetsDomain ? '' : '/pets';

    const subtotalCents = items.reduce((sum, item) => sum + (productMap[item.product_id].price_cents * item.quantity), 0);
    const shippingCents = subtotalCents >= 5000 ? 0 : 599;
    const totalCents = subtotalCents + shippingCents;

    const successUrl = `${origin}${petsPrefix}/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}${petsPrefix}/cart`;

    let sessionUrl, stripeSessionId;

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      const Stripe = require('stripe');
      const stripe = Stripe(stripeKey);
      const lineItems = items.map(item => {
        const product = productMap[item.product_id];
        return {
          price_data: {
            currency: 'usd',
            product_data: { name: product.name, images: product.image_url ? [product.image_url] : [] },
            unit_amount: product.price_cents
          },
          quantity: item.quantity
        };
      });
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: lineItems,
        mode: 'payment',
        customer_email: email || undefined,
        shipping_address_collection: { allowed_countries: ['US'] },
        shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: shippingCents, currency: 'usd' }, display_name: shippingCents === 0 ? 'Free Shipping' : 'Standard Shipping (7-14 days)', delivery_estimate: { minimum: { unit: 'business_day', value: 7 }, maximum: { unit: 'business_day', value: 14 } } } }],
        success_url: successUrl,
        cancel_url: cancelUrl
      });
      sessionUrl = session.url;
      stripeSessionId = session.id;
      console.log(`[Pets] Stripe SDK session created: ${stripeSessionId}`);
    } else {
      const polsiaApiKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
      const polsiaStripePath = process.env._POLSIA_STRIPE_PATH;
      if (polsiaApiKey && polsiaStripePath) {
        const polsiaBaseUrl = (process.env.POLSIA_R2_BASE_URL || 'https://polsia.com').replace(/\/$/, '');
        const stripeLineItems = items.map(item => {
          const product = productMap[item.product_id];
          return { name: product.name, amount: product.price_cents / 100, quantity: item.quantity };
        });
        if (shippingCents > 0) stripeLineItems.push({ name: 'Standard Shipping (7-14 days)', amount: shippingCents / 100, quantity: 1 });
        const stripeRes = await fetch(`${polsiaBaseUrl}${polsiaStripePath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': polsiaApiKey, 'Authorization': `Bearer ${polsiaApiKey}` },
          body: JSON.stringify({ line_items: stripeLineItems, success_url: successUrl, cancel_url: cancelUrl })
        });
        const stripeData = await stripeRes.json();
        if (stripeData.success && stripeData.checkout_session && stripeData.checkout_session.url) {
          sessionUrl = stripeData.checkout_session.url;
          stripeSessionId = stripeData.checkout_session.stripe_session_id || String(stripeData.checkout_session.id);
          console.log(`[Pets] Polsia Stripe session created: ${stripeSessionId}`);
        }
      }
      if (!sessionUrl) {
        console.error('[Pets] No STRIPE_SECRET_KEY and no Polsia Stripe API — cannot process payment');
        return res.status(503).json({ success: false, message: 'Payment processing is being set up. Please check back shortly!' });
      }
    }

    const orderResult = await pool.query(
      `INSERT INTO pet_orders (email, subtotal_cents, shipping_cents, total_cents, status, stripe_session_id)
       VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id`,
      [email || 'unknown', subtotalCents, shippingCents, totalCents, stripeSessionId]
    );
    const orderId = orderResult.rows[0].id;
    for (const item of items) {
      const product = productMap[item.product_id];
      await pool.query(
        `INSERT INTO pet_order_items (order_id, product_id, product_name, quantity, unit_price_cents, product_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [orderId, product.id, product.name, item.quantity, product.price_cents, JSON.stringify(product)]
      );
    }
    console.log(`[Pets] Checkout session created: order #${orderId}, stripe session ${stripeSessionId}`);
    res.json({ success: true, url: sessionUrl });
  } catch (err) {
    console.error('[Pets] Checkout error:', err.message);
    res.status(500).json({ success: false, message: 'Something went wrong during checkout. Please try again.' });
  }
});

// ── ORDER CONFIRM LOGIC ───────────────────────────────────────────────────────
async function handleOrderConfirm(sessionId, sessionData) {
  try {
    let session = sessionData;
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!session && stripeKey) {
      try {
        const Stripe = require('stripe');
        const stripe = Stripe(stripeKey);
        session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ['shipping_details', 'customer_details', 'line_items']
        });
      } catch (err) {
        console.error('[OrderConfirm] Stripe session fetch failed:', err.message);
      }
    }
    const orderRes = await pool.query(
      `SELECT o.*, json_agg(json_build_object(
        'product_name', oi.product_name,
        'quantity', oi.quantity,
        'unit_price_cents', oi.unit_price_cents
      )) as items
       FROM pet_orders o
       LEFT JOIN pet_order_items oi ON oi.order_id = o.id
       WHERE o.stripe_session_id = $1
       GROUP BY o.id`,
      [sessionId]
    );
    if (!orderRes.rows.length) {
      console.error('[OrderConfirm] Order not found for session:', sessionId);
      return null;
    }
    const order = orderRes.rows[0];
    if (order.email_sent_at) {
      console.log(`[OrderConfirm] Email already sent for order #${order.id}`);
      return order;
    }
    const updates = { status: 'paid' };
    if (session) {
      const shipping = session.shipping_details || session.shipping;
      const customer = session.customer_details;
      if (shipping && shipping.address) {
        updates.shipping_address = { line1: shipping.address.line1, line2: shipping.address.line2 || null, city: shipping.address.city, state: shipping.address.state, postal_code: shipping.address.postal_code, country: shipping.address.country };
        updates.name = shipping.name;
      } else if (customer) {
        updates.name = customer.name || order.name;
        if (customer.address) updates.shipping_address = customer.address;
      }
      if (customer && customer.email && (!order.email || order.email === 'unknown')) {
        updates.email = customer.email;
      }
    }
    await pool.query(
      `UPDATE pet_orders SET status = $1, name = COALESCE($2, name), email = COALESCE(NULLIF($3, 'unknown'), email), shipping_address = COALESCE($4::jsonb, shipping_address), email_sent_at = NOW(), updated_at = NOW() WHERE id = $5`,
      [updates.status, updates.name || null, updates.email || null, updates.shipping_address ? JSON.stringify(updates.shipping_address) : null, order.id]
    );
    const updatedOrder = { ...order, ...updates };
    const items = Array.isArray(order.items) ? order.items.filter(i => i.product_name) : [];
    console.log(`[Orders] New paid order #${order.id} — $${(order.total_cents / 100).toFixed(2)}`);
    sendOrderEmail(updatedOrder, items).catch(err => console.error('[Orders] Email error:', err.message));
    return updatedOrder;
  } catch (err) {
    console.error('[OrderConfirm] Error:', err.message);
    return null;
  }
}

router.get('/order/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await pool.query(
      `SELECT o.id, o.email, o.status, o.subtotal_cents, o.shipping_cents, o.total_cents, o.created_at,
              json_agg(json_build_object('name', oi.product_name, 'quantity', oi.quantity, 'unit_price_cents', oi.unit_price_cents)) as items
       FROM pet_orders o
       LEFT JOIN pet_order_items oi ON oi.order_id = o.id
       WHERE o.stripe_session_id = $1 OR o.id::text = $1
       GROUP BY o.id`,
      [sessionId]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error('[Pets] Order fetch error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// NOTE: stripe-webhook must receive raw body — server.js sets up express.raw() before this router
router.post('/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  let event;
  if (webhookSecret && sig) {
    try {
      const Stripe = require('stripe');
      const stripe = Stripe(stripeKey);
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('[Webhook] Signature verification failed:', err.message);
      return res.status(400).json({ error: 'Invalid signature' });
    }
  } else {
    try { event = JSON.parse(req.body); }
    catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await handleOrderConfirm(session.id, session);
  }
  res.json({ received: true });
});

router.post('/order-confirm', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ success: false, message: 'Missing session_id' });
  const order = await handleOrderConfirm(session_id, null);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  res.json({ success: true, order_id: order.id });
});

// ── PAGE ROUTES ───────────────────────────────────────────────────────────────
// Mounted at /pets in server.js, so paths here are relative (e.g., /shop, /product)

// SEO product page — server-side meta injection
router.get('/product', async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.sendFile(path.join(__dirname, '..', 'public', 'pets', 'product.html'));
  try {
    const result = await pool.query('SELECT * FROM pet_products WHERE slug = $1', [slug]);
    const product = result.rows[0];
    if (!product) return res.sendFile(path.join(__dirname, '..', 'public', 'pets', 'product.html'));

    let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'pets', 'product.html'), 'utf8');
    const price = (product.price_cents / 100).toFixed(2);
    const image = Array.isArray(product.images) && product.images[0]
      ? product.images[0]
      : 'https://m.media-amazon.com/images/I/81Nrb092uIL.jpg';
    const rawDesc = (product.description || '').replace(/"/g, '&quot;');
    const metaDesc = `${product.name} — $${price}. ${rawDesc.substring(0, 130)}`;
    const canonical = `https://funkfactorypets.com/product?slug=${encodeURIComponent(slug)}`;
    const jsonName = (product.name || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const jsonDesc = (product.description || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
    const catMap = { dogs: 'Dogs', cats: 'Cats', 'small-pets': 'Small Pets', accessories: 'Accessories' };
    const catLabel = catMap[product.category] || 'Shop';
    const catUrl = `https://funkfactorypets.com/shop?category=${encodeURIComponent(product.category || '')}`;

    const seoHead = `<title>${product.name} — Funk Factory Pets</title>
  <meta name="description" content="${metaDesc}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="product">
  <meta property="og:site_name" content="Funk Factory Pets">
  <meta property="og:url" content="${canonical}">
  <meta property="og:title" content="${product.name} — Funk Factory Pets">
  <meta property="og:description" content="${metaDesc}">
  <meta property="og:image" content="${image}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${product.name} — Funk Factory Pets">
  <meta name="twitter:description" content="${metaDesc}">
  <meta name="twitter:image" content="${image}">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Product","name":"${jsonName}","description":"${jsonDesc}","image":"${image}","brand":{"@type":"Brand","name":"Funk Factory Pets"},"offers":{"@type":"Offer","url":"${canonical}","priceCurrency":"USD","price":"${price}","availability":"https://schema.org/InStock","seller":{"@type":"Organization","name":"Funk Factory Pets"}}}
  <\/script>
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://funkfactorypets.com/"},{"@type":"ListItem","position":2,"name":"${catLabel}","item":"${catUrl}"},{"@type":"ListItem","position":3,"name":"${jsonName}","item":"${canonical}"}]}
  <\/script>`;

    html = html.replace('<title>Product — Funk Factory Pets 🐾</title>', seoHead);
    res.type('html').send(html);
  } catch (err) {
    console.error('[SEO] Product SSR error:', err);
    res.sendFile(path.join(__dirname, '..', 'public', 'pets', 'product.html'));
  }
});

const petPages = ['shop', 'cart', 'checkout', 'success', 'about', 'shipping', 'returns'];
petPages.forEach(page => {
  router.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'pets', `${page}.html`));
  });
});
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pets', 'index.html'));
});

module.exports = router;

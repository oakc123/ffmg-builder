// Entry point: wiring only — middleware, domain routing, route mounts, listen
// All route logic lives in routes/; DB pool lives in db/index.js
const express = require('express');
const path = require('path');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { migrate } = require('./migrate');

const app = express();
const port = process.env.PORT || 3000;

// Raw body parser for Stripe webhooks (must come before express.json())
app.use('/api/pets/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── CUSTOM DOMAIN ROUTING — rewrite funkfactorypets.com → /pets paths ─────────
const PETS_DOMAIN = 'funkfactorypets.com';
const PETS_PAGE_SLUGS = new Set(['shop', 'product', 'cart', 'checkout', 'success', 'about', 'shipping', 'returns']);

app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/^www\./, '').replace(/:\d+$/, '');
  if (host.toLowerCase() !== PETS_DOMAIN) return next();
  if (req.path.startsWith('/api')) return next();
  if (req.path === '/pets') return res.redirect(301, '/');
  if (req.path.startsWith('/pets/')) {
    const newPath = req.path.slice(5);
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect(301, newPath + qs);
  }
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|txt|xml)$/.test(req.path)) return next();
  if (req.path === '/') { req.url = '/pets'; return next(); }
  const slug = req.path.slice(1).split('/')[0];
  if (PETS_PAGE_SLUGS.has(slug)) {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = '/pets/' + slug + qs;
    return next();
  }
  req.url = '/pets';
  return next();
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// ── ONE-TIME LOGO GENERATION (TEMP — remove after use) ────────────────────────
app.post('/api/internal/generate-ffmg-logo', async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (secret !== 'ffmg-logo-gen-2026') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
    const prompt = `A professional circular badge logo for "Funk Factory Media Group" (FFMG). Clean vector-style illustration on white background.

Design details:
- Circular badge shape
- Outer thin decorative ring in warm gold/copper color (#D4956A)
- "FUNK FACTORY" text arched along the top inside the circle, dark brown color (#6B3A1F), bold uppercase sans-serif
- "MEDIA GROUP" text arched along the bottom inside the circle, same dark brown color
- Center: large bold block letters "FFMG" in warm gold/copper color (#D4956A)
- A dark brown filled play button triangle integrated into or beside the letter M in FFMG
- Small decorative bullet dot separators on the left and right sides between the arched text
- White background, clean professional media company look
- Sharp edges, high contrast, print-ready quality`;

    console.log('[logo-gen] Generating with DALL-E 3...');
    const image = await openai.images.generate({
      model: 'dall-e-3',
      prompt,
      size: '1024x1024',
      quality: 'hd',
      n: 1,
    });
    const imageUrl = image.data[0].url;
    console.log('[logo-gen] Image generated:', imageUrl.substring(0, 80));

    // Download the image
    const imgRes = await fetch(imageUrl);
    const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
    console.log('[logo-gen] Downloaded:', imageBuffer.length, 'bytes');

    // Upload to R2
    const url = await uploadToR2(imageBuffer, 'ffmg-logo.png', 'image/png');
    console.log('[logo-gen] Uploaded to R2:', url);

    res.json({ success: true, url });
  } catch (err) {
    console.error('[logo-gen] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── R2 UPLOAD (public endpoint) ───────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});
async function uploadToR2(buffer, filename, mimeType) {
  const formData = new FormData();
  formData.append('file', buffer, { filename, contentType: mimeType });
  const response = await fetch('https://polsia.com/api/proxy/r2/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.POLSIA_API_KEY}`, ...formData.getHeaders() },
    body: formData
  });
  const result = await response.json();
  if (!result.success) throw new Error(result.error?.message || 'R2 upload failed');
  return result.file.url;
}
app.post('/api/r2/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });
    const url = await uploadToR2(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json({ success: true, url, public_url: url });
  } catch (err) {
    console.error('[R2 Upload] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── ROUTE MOUNTS — API ────────────────────────────────────────────────────────
app.use('/api/gallery',        require('./routes/gallery'));
app.use('/api/admin',          require('./routes/admin-portal')); // new JWT portal (auth, notifications, dashboard, jobs)
app.use('/api/admin',          require('./routes/admin'));         // legacy cookie auth (gallery, gigs, orders, analytics)
app.use('/api/pets',      require('./routes/pets'));
app.use('/api/contact',   require('./routes/contact'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/intake',    require('./routes/intake'));
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/messages',  require('./routes/messages'));
app.use('/api/preview',   require('./routes/preview'));
app.use('/api/portal',    require('./routes/portal'));
app.use('/api/jobs',      require('./routes/jobs'));          // homelab intake job proxy + latest
app.use('/api/work',      require('./routes/case-studies'));   // /work portfolio hub: case-study tile API

// ── SEO: robots.txt + sitemap.xml (must come before static so routes take priority) ──────────
app.use('/', require('./routes/seo'));

// ── FFMG PAGE ROUTES (/, /intake, /services, /what-we-offer) ─────────────────
app.use('/', require('./routes/pages'));

// ── STATIC FILES ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── PORTAL PAGE ───────────────────────────────────────────────────────────────
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));

// ── ADMIN PANEL PAGES ─────────────────────────────────────────────────────────
// New portal pages (JWT auth, light theme)
app.get('/admin/login',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html')));
app.get('/admin/dashboard',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin/jobs',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'jobs.html')));
app.get('/admin/jobs/:job_id',(req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'job-detail.html')));
app.get('/admin/messages',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'messages.html')));
app.get('/admin/costs',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'costs.html')));
app.get('/admin/forgot-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'forgot-password.html')));
app.get('/admin/reset-password',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'reset-password.html')));
app.use('/dashboard', require('./routes/dashboard'));
app.get('/dashboard/ffmg-express', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'ffmg-express.html')));
// Legacy admin pages (cookie auth, dark theme — kept for gallery/gigs/orders/analytics)
app.get('/admin',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/orders',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-orders.html')));
app.get('/admin/gigs',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-gigs.html')));
app.get('/admin/analytics', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-analytics.html')));

// ── PET STORE PAGES ───────────────────────────────────────────────────────────
app.use('/pets', require('./routes/pets'));

// ── PUBLIC NOT-FOUND FALLBACK ────────────────────────────────────────────────
app.use(require('./routes/not-found'));

// ── SERVER START ──────────────────────────────────────────────────────────────
async function startServer() {
  try {
    await migrate();
  } catch (err) {
    console.error('Startup migration failed:', err.message);
    process.exit(1);
  }

  app.listen(port, () => {
  console.log(`Server running on port ${port}`);

  // One-time Stripe API endpoint discovery on startup
  const polsiaApiKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const polsiaBaseUrl = (process.env.POLSIA_R2_BASE_URL || 'https://polsia.com').replace(/\/$/, '');
  if (!polsiaApiKey) { console.warn('[Stripe] No POLSIA_API_KEY — payments disabled'); return; }

  const candidatePaths = [
    '/api/stripe/create-checkout-session',
    '/api/v1/stripe/create-checkout-session',
    '/stripe/v1/checkout-sessions',
    '/api/mcp/stripe/create_checkout_session'
  ];
  const testBody = JSON.stringify({
    line_items: [{ name: 'Startup Test', amount: 1, quantity: 1 }],
    success_url: 'https://funkfactoryos.polsia.app/pets/success',
    cancel_url: 'https://funkfactoryos.polsia.app/pets/cart'
  });
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': polsiaApiKey,
    'Authorization': `Bearer ${polsiaApiKey}`
  };

  (async () => {
    for (const p of candidatePaths) {
      try {
        const r = await fetch(`${polsiaBaseUrl}${p}`, { method: 'POST', headers, body: testBody });
        const text = await r.text();
        if (text.startsWith('{') || text.startsWith('[')) {
          const data = JSON.parse(text);
          if (data.success && data.checkout_session) {
            console.log(`[Stripe] DISCOVERED working endpoint: ${p}`);
            process.env._POLSIA_STRIPE_PATH = p;
            return;
          }
        }
      } catch (err) {
        console.log(`[Stripe] ${p} → error: ${err.message}`);
      }
    }
    console.error('[Stripe] No working endpoint found — checkout will fail');
  })();
  });
}

startServer();

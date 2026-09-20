# FunkFactoryOS — CLAUDE.md

## What this app does
FunkFactoryOS is the web platform for Funk Factory Media Group (FFMG), a New Mexico sports photography, videography, and web design business. It serves the FFMG marketing site, a client intake/lead-gen workflow, a pet-supply e-commerce storefront (Funk Factory Pets), and an admin dashboard for orders, gallery, gigs, and analytics.

## Stack
Node.js 18 + Express · Neon PostgreSQL (raw Pool queries via db/index.js) · Render (web service) · Polsia R2 (file storage) · Multer (uploads) · node-fetch v2

## Directory map
- `server.js` — Express entry; wiring only (middleware, domain routing, route mounts, listen). Hard cap 300 lines.
- `routes/` — one file per route group: admin.js (legacy cookie auth), admin-portal.js (new JWT portal), analytics.js, auth.js, contact.js, gallery.js, intake.js, jobs.js (homelab intake proxy + /api/jobs/latest), messages.js, pages.js, pets.js, portal.js, preview.js, seo.js
- `db/index.js` — single Pool constructor; all queries go through this module
- `db/admin.js` — admin_notifications + dashboard aggregate queries
- `db/customers.js` — customer + magic_link_tokens + project_progress queries
- `db/express-nurture.js` — FFMG Express lead-nurture send tracking (recordSend + queueableContactsForDay)
- `db/messages.js` — messages table queries
- `public/` — static HTML pages served directly
- `public/admin/` — new light-theme admin portal (login.html, index.html/dashboard, jobs.html, job-detail.html, messages.html, costs.html)
- `migrations/` — JS migration files run via `migrate.js` on deploy
- `migrate.js` — migration runner
- `render.yaml` — Render deploy config

## Public pages
- `/` → `public/index.html` — FFMG homepage (sports hero, gallery, contact)
- `/about` → `public/about.html` — Company story, values, service list, territory map, CTA
- `/services` → `public/services.html` — Media production services page
- `/what-we-offer` → `public/what-we-offer.html` — Web design packages (Standard $2.5K / Premium $5K)
- `/intake` → `public/intake.html` — 4-section client intake form (contact, project, brand, images); generates UUID, stores in localStorage
- `/portfolio` → `public/portfolio.html` — Portfolio/case studies: 5 project cards (video, photo, social, brand film, web), filter tabs by category, CTA section
- `/portal` → `public/portal.html` — Customer project portal: magic link auth, project status, messages
- `/blog` → `public/blog/index.html` — Blog index: article listing with featured card + grid layout
- `/blog/concert-videographer-albuquerque` → Article 1 (SEO: "concert videographer Albuquerque", multi-camera coverage, venue case studies)
- `/blog/event-photography-packages-new-mexico` → Article 2 (SEO: "event photography packages New Mexico", package tiers, RRHS case study)
- `/admin/login` → new JWT admin login (light theme)
- `/admin/dashboard` → new admin dashboard: metrics, activity feed, pending jobs queue
- `/admin/jobs` → jobs list: table with filters (status/package/search), links to detail
- `/admin/jobs/[job_id]` → job detail: brief, plan, task approval, package override, build trigger, preview, customer response, flag
- `/admin/messages` → 2-panel inbox: job list (unread counts) + thread view + compose area; auto-refresh 30s
- `/admin/costs` → API cost dashboard: summary cards, model usage bar chart (canvas), sortable paginated breakdown table; proxies `builder.funkfactorymediagroup.com/costs/summary`
- `/admin` — Legacy admin panel (gallery/gigs/orders, cookie auth)
- `/pets` — Pet store (Funk Factory Pets sub-site, also reachable at funkfactorypets.com)

## Database
- `admin_users` — admin portal users (email, PBKDF2 password hash, reset_token/expires for password recovery)
- `contact_submissions` — FFMG booking/contact form leads
- `gallery_photos` — uploaded photos with category, caption, R2 URL
- `gigs` — event/gig tracker entries
- `pet_orders` / `pet_order_items` / `pet_products` — Funk Factory Pets e-commerce
- `page_views` — privacy-safe analytics (hashed visitor, path, UTM params)
- `intake_submissions` — client intake form submissions (web design leads); now includes customer_uuid + job_id
- `customers` — one row per web design client (uuid, email, name, package_tier, project_status, job_id)
- `messages` — threaded messages between client (customer) and FFMG team (agent) per job_id
- `magic_link_tokens` — one-time HMAC-signed login tokens (15-min expiry, used flag)
- `project_progress` — preview URLs and milestone notes posted by FFMG team per customer
- `admin_notifications` — notification records for admin bell (new submissions, pending approvals, customer messages)
- `express_nurture_sends` — per-contact Day 0 / Day 3 / Day 7 Klaviyo send timestamps for FFMG Express lead-nurture drip

## External integrations
- **Polsia R2** — file/image storage via `POLSIA_R2_BASE_URL` + `POLSIA_API_KEY`
- **Polsia Email Proxy** — outbound order/notification emails
- **Stripe** — pet store checkout via Polsia Stripe proxy or `STRIPE_SECRET_KEY` directly
- **FFMG Intake Service** — `https://intake.funkfactorymediagroup.com`; jobs index/detail/patch via `X-Polsia-Secret: ffmg-intake-2026`
- **FFMG Builder Service** — `https://builder.funkfactorymediagroup.com` (formerly assistant); build trigger via `ASSISTANT_API_KEY` env var, costs via `ASSISTANT_BASE_URL` env var
- **Google Fonts** — Space Grotesk + DM Sans

## Recent changes
- **2026-07-18** — Wired FFMG Express lead-nurture drip: rendered HTML previews at `public/emails/express/01-acknowledgment.html` (Day 0), `public/emails/express/02-case-study.html` (Day 3), `public/emails/express/03-re-engagement.html` (Day 7), and an owner-facing stack at `public/emails/express/_preview.html` (no new route — served via existing `express.static` mount). Migration `1752457600000_add_express_nurture_sends.js` adds `express_nurture_sends (contact_id, stage, sent_at, klaviyo_event_id)` PK on `(contact_id, stage)` (CHECK stage IN 1/2/3). `db/express-nurture.js` exposes `recordSend()` (ON CONFLICT DO NOTHING) and `queueableContactsForDay(N)` (rolling 1-day window, excludes converted leads via lower(email) join to `intake_submissions` and excludes already-sent contacts). `routes/contact.js` fires Stage 1 immediately after the existing insert resolves — POSTs `FFMG Express Lead Submitted` to `KLAVIYO_WEBHOOK_URL` and records the send; never blocks the user-facing 200 (mirrors `createNotification` fire-and-forget pattern). New daily cron `jobs/express-lead-nurture-daily.js` (Day 3 + Day 7) wired via new `[[crons]]` block in `polsia.toml` at `0 14 * * *`. Owner sandbox setup checklist at `docs/klaviyo-express-nurture-flow.md` — `KLAVIYO_WEBHOOK_URL` left blank until flow goes Live; local `express_nurture_sends` writes happen regardless so `/dashboard/ffmg-express` attribution tracks deltas.
- **2026-05-27** — Added homelab intake monitor: `routes/jobs.js` proxies `GET /api/jobs` (full list) and `GET /api/jobs/latest` (most recent, with new-job detection + email alert to amer.child@funkfactorymediagroup.com); "Homelab Intake Monitor" widget added to admin dashboard (`public/admin/index.html`) with 15-min polling and on-screen new-job banner.
- **2026-05-24** — Added admin forgot/reset password flow: `admin_users` table (migration `1748000000000_add_admin_users.js`) with `reset_token`/`reset_token_expires` columns; `db/admin-users.js` handles PBKDF2 hashing (no external deps), reset token generation/storage, password update by token; `POST /api/admin/forgot-password` (rate-limited 3/hr per email, crypto.randomBytes token, 1hr expiry, branded email via Polsia proxy); `POST /api/admin/reset-password` (validates token+expiry, updates PBKDF2 hash, clears token); new pages `/admin/forgot-password` and `/admin/reset-password?token=xxx` with matching light theme; "Forgot your password?" link added to login page.
- **2026-05-23** — Added favicon files (`public/favicon.svg` — copper circle + play-button icon, `public/favicon.png` 32x32) and PNG logo export (`public/images/ffmg-logo.png` 2048x2048 rasterized from SVG via sharp). Updated all 10 FFMG pages: replaced inline data-URI favicon with `/favicon.svg` + `/favicon.png` file references; updated og:image to point to PNG instead of SVG.
- **2026-05-23** — Deployed FFMG logo SVG (`public/images/ffmg-logo.svg`): circular badge, gold/copper rings, FFMG block letters with play-triangle in M, arched "FUNK FACTORY / MEDIA GROUP" text. Replaced all placeholder nav logos, footer marks, favicons, og:image tags, and JSON-LD logo URLs across 11 non-pets FFMG pages.
- **2026-05-22** — Fixed intake form brand colors bug: color pickers had hardcoded FFMG defaults (#D4956A, #6B3A1F) as HTML `value` attributes, causing every submission to send FFMG colors. Replaced with opt-in checkbox toggles per slot (unchecked by default); submission code only sends colors the client explicitly enabled. If all unchecked, `brand.colors` is `[]`.
- **2026-05-18** — Built SEO blog section: `/blog` index page (article grid + featured card), Article 1 "Concert Videographer Albuquerque" (multi-camera coverage, Sunshine Theater + Rattlesnake Bar case studies, 48hr turnaround), Article 2 "Event Photography Packages New Mexico" (package tier comparison table, delivery timeline, RRHS Football case study with 12K+ stills). Added blog routes to routes/pages.js, blog pages to sitemap in routes/seo.js. Blog uses existing light theme (Space Grotesk + DM Sans, copper accent).


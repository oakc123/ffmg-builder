# FFMG Express Lead Nurture — Owner Review Brief

> **Status: OWNER REVIEW REQUIRED.** This is a content deliverable. No code wiring has been changed. A follow-on build plan will integrate the sequence into `routes/contact.js` after sign-off.

## 1. Campaign overview

| Field | Value |
|---|---|
| Campaign name | FFMG Express Lead Nurture |
| Goal | Keep leads warm between contact form submit and 4-section intake form completion |
| Target audience | One-time visitor who filled out `POST /api/contact` for a web / photo / video project |
| Cadence | Day 0 (immediate), Day 3, Day 7 — measured from `contact_submissions.createdAt` |
| Unsubscribe | Reply STOP to opt out. Footer identifies sender as "Funk Factory Media Group — Albuquerque sports media + web" |
| Trigger event | New row in `contact_submissions` (see `routes/contact.js:9`) |
| Goal conversion event | New row in `intake_submissions` referencing the same customer (tracked on `/dashboard/ffmg-express`) |

**Funnel context.** Today the gap the drip targets is between page_view → contact form → intake form. The contact form captures enough info for a personal hello, but doesn't have enough project detail to scope a proposal — that's why the intake form exists. The drip's job is to keep the visitor oriented and motivated during the 0–7 day window when they're deciding whether to fill out the longer intake.

## 2. Stage tables

### Stage 1 — Acknowledgment

| Field | Value |
|---|---|
| Stage | 1. Acknowledgment + what's next + 2 business day SLA |
| Subject | `We got your FFMG Express request, {{FIRST_NAME}}` |
| Preheader | `Here's what happens next — including your 2 business day SLA.` |
| Send delay | Day 0 (fires immediately after `POST /api/contact` returns 200) |
| Primary CTA | `Complete the 4-section intake →` `/intake` |
| Failure mode if lead skips | Falls through to Stage 2 (Day 3). If still no intake by Day 7, Stage 3 fires. After Stage 3 with no conversion, lead is dropped from the drip and surfaced only on the attribution dashboard for manual follow-up |

### Stage 2 — Case study

| Field | Value |
|---|---|
| Stage | 2. Social proof / case study highlight |
| Subject | `How three New Mexico teams launched with FFMG` |
| Preheader | `Recent projects from RRHS, Sunshine Theater, and a $2.5K web build.` |
| Send delay | Day 3 |
| Primary CTA | `Lock your slot — finish the intake →` `/intake` |
| Failure mode if lead skips | Stage 3 fires on Day 7 with a soft urgency trigger |

### Stage 3 — Gentle re-engagement

| Field | Value |
|---|---|
| Stage | 3. Gentle re-engagement with urgency trigger |
| Subject | `One last check-in on your FFMG Express request` |
| Preheader | `Your open slot is held for 7 days — after that it moves to the next intake.` |
| Send delay | Day 7 (7 days from `contact_submissions.createdAt`) |
| Primary CTA | `Take 4 minutes to finish the intake →` `/intake` |
| Failure mode if lead skips | Lead is removed from the active drip. They remain in `contact_submissions` for manual owner follow-up and are still counted in the attribution dashboard funnel |

## 3. Email 1 — Acknowledgment (Day 0)

> Reuse exactly these placeholders so the owner can sanity-check before wiring.

**Body copy:**

Hi `{{FIRST_NAME}}`,

Thanks for reaching out through FFMG Express. We just received your message and it's queued for `amer.child@funkfactorymediagroup.com`. Within **2 business days** you'll hear from them with a custom proposal and 2–3 clarifying questions.

While you wait, the fastest way to move forward is to complete our 4-section intake form — it takes about 4 minutes and gives us everything we need to scope and price your project accurately.

**Most web design projects ship in 7–14 days from intake approval**, so the sooner the intake is in, the sooner we can reserve a build slot.

[ **Complete the 4-section intake →** ] (/intake)

Direct link: `https://funkfactoryos.polsia.app/intake`

— Amer Child, Funk Factory Media Group

---

## 4. Email 2 — Case study (Day 3)

**Lead-in paragraph (one short paragraph):**

Since you reached out about your project, here's a look at three we shipped recently in New Mexico — same team, different shape. Every one of these started the same way your project will: with a short intake and a 2-business-day proposal.

### Case study card 1 — RRHS Football: 12K+ stills in 48 hours

> **Event photography coverage scaled overnight.** We dispatched two shooters for the Rio Rancho High School football opener and delivered 12,000+ edited stills to the athletics department within 48 hours for use across social, the year-end media kit, and sponsor recaps.
>
> Read the full case study → `/blog/event-photography-packages-new-mexico`

### Case study card 2 — Sunshine Theater: multi-cam concert coverage

> **Multi-camera concert videography in downtown Albuquerque.** A four-camera lockoff + roaming setup at Sunshine Theater captured the full headliner set plus crowd energy for both the venue's promo reel and the artist's next tour announcement.
>
> Read the full project write-up → `/blog/concert-videographer-albuquerque`

### Case study card 3 — Standard $2.5K web build with a real testimonial

> **Standard web package, before / after.** A New Mexico small-business owner came in with a five-page Wix site and left with a 7-page responsive build (Standard tier, $2.5K) plus a content refresh.
>
> *"{{TESTIMONIAL_1_QUOTE}}"* — actual quote, owner pastes from the new testimonials block on `/` (index.html)
>
> See the package breakdown → `/what-we-offer`

[ **Lock your slot — finish the intake →** ] (/intake)

Direct link: `https://funkfactoryos.polsia.app/intake`

— Amer Child, Funk Factory Media Group

> **Owner TODO before send:** Replace `{{TESTIMONIAL_1_QUOTE}}` with the quote pulled from the testimonials section of `public/index.html`.

---

## 5. Email 3 — Re-engagement (Day 7)

> Tone is gentle, not pushy. Honest about the slot, respectful of "no" replies.

**Subject:** `One last check-in on your FFMG Express request`

**Body copy:**

Hi `{{FIRST_NAME}}`,

Just checking in once more — and if the timing isn't right, no hard feelings. Reply **"not now"** and we'll pause the conversation until you reach back out.

For transparency on our side: we hold an open project slot for **7 days from your form submit**; after that, the slot moves to the next intake in queue. We're telling you this so the timeline is honest, not so we can rush you.

If this *is* still on your radar, the intake is the only thing standing between your message and a custom proposal.

[ **Take 4 minutes to finish the intake →** ] (/intake)

Direct link: `https://funkfactoryos.polsia.app/intake`

Reply **"still interested"** or **"not now"** — we'll respect whichever.

— Amer Child, Funk Factory Media Group

---

## 6. Brand tokens reference

These tokens are reused verbatim from the existing password-reset email at `routes/admin-portal.js:506-538`.

| Token | Hex | Where used |
|---|---|---|
| Brown | `#6B3A1F` | Logo SVG block background ("F" mark background) |
| Copper | `#D4956A` | Logo SVG "F" fill; primary CTA button background |
| Heading | `#1a0f08` | Email `<h1>` and card headings |
| Body text | `#6b5c50` | All paragraph copy at 15px / line-height 1.6 |
| Page background | `#faf6f1` | Outer email body background |
| Card background | `#ffffff` | Inner card background |
| Card border | `rgba(107,58,31,0.12)` | 1px card border |
| Divider | `rgba(107,58,31,0.1)` | Top border before footer microcopy |
| Footer text | `#9b8a7e` | "Funk Factory Media Group · Albuquerque, NM" footer line |
| Font family | `'DM Sans', Arial, sans-serif` | Body |
| Card max-width | `520px` | Centered card width |

## 7. Sign-off & next steps

- **OWNER REVIEW REQUIRED** before this sequence is wired into `routes/contact.js`.
- After sign-off, a follow-on build plan will:
  1. Add a `nurture_emails_sent` migration to track stage 1/2/3 send timestamps per contact row.
  2. Modify `routes/contact.js` line 28 (the existing handler) to fire Stage 1 immediately on successful insert.
  3. Add `jobs/express-lead-nurture-daily.js` + a `[[crons]]` entry in `polsia.toml` to enqueue Stage 2 (Day 3) and Stage 3 (Day 7) sends.
- Today's deliverable is content only: this brief + the 3 HTML preview files + the owner preview landing page. Rendered previews live at:
  - `public/emails/express/01-acknowledgment.html`
  - `public/emails/express/02-case-study.html`
  - `public/emails/express/03-re-engagement.html`
  - Preview index: `public/emails/express/_preview.html`

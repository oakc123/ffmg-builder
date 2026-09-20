# Klaviyo Sandbox Setup — FFMG Express Lead Nurture

> **Status: OWNER REVIEW.** This checklist walks the owner through wiring the Day 0 / Day 3 / Day 7 flow inside the Klaviyo sandbox account. The Express app only posts the trigger events (`FFMG Express Lead Submitted` / `FFMG Express Lead Day 3` / `FFMG Express Lead Day 7`) and records per-contact send timestamps in `express_nurture_sends` — the actual email templates, send timing, and exit filters live inside Klaviyo.

## 0. Confirmations before starting

- Reviewed emails render correctly at `https://funkfactoryos.polsia.app/emails/express/_preview.html`.
- Approved the body copy in `docs/ffmg-express-lead-nurture.md` (Day 0 acknowledgment, Day 3 case study, Day 7 re-engagement).
- Chose the testimonial to paste into Email 2 (the `{{TESTIMONIAL_1_QUOTE}}` placeholder in `public/emails/express/02-case-study.html`).
- Sandbox account is the same one the FFMG team already uses for transactional sends.

## 1. Create the segment

1. Navigate to **Lists & Segments → Create List / Segment**.
2. Name: `FFMG Express Lead Nurture - Day 0 to Day 7`.
3. Filter conditions:
   - **Has submitted FFMG Express contact form** (the metric defined in step 2)
   - **AND Has not submitted FFMG intake form** (the conversion gate)

   In Klaviyo: use the condition builder and pick `What someone has done` → `Submitted FFMG Express contact form` at least once, and `What someone has not done` → `Submitted FFMG intake form`.

## 2. Create the custom metric

1. **Settings → Metrics → Create Metric**.
2. Name: `FFMG Express Lead Submitted` (matches the event name posted from `routes/contact.js` in `triggerStage1()`).
3. Service: `Custom`.
4. Repeat for the two follow-on metrics so the flow can group on them:
   - `FFMG Express Lead Day 3` (posted from `jobs/express-lead-nurture-daily.js`, Stage 2)
   - `FFMG Express Lead Day 7` (posted from the same job, Stage 3)

   The metric names must match *exactly*. If they're off, the flow trigger will silently fail to fire and you'll see zero dispatches in the analytics tab.

## 3. Paste the email templates

In **Content → Templates**, create three new email templates:

- `FFMG Express — Day 0 Acknowledgment`
  - Body copied from `public/emails/express/01-acknowledgment.html`.
  - Map `{{FIRST_NAME}}` to the Klaviyo profile property `$first_name`.
  - Subject line: `We got your FFMG Express request, {{first_name|default:'there'}}`.
  - Preheader: `Here's what happens next — including your 2 business day SLA.`

- `FFMG Express — Day 3 Case Study`
  - Body copied from `public/emails/express/02-case-study.html`.
  - Map `{{FIRST_NAME}}` to `$first_name`.
  - Replace `{{TESTIMONIAL_1_QUOTE}}` with the live quote copied from the testimonials section of `public/index.html` (testimonials section, line ~1879). Verified live quotes available: Maria Torres (Sunshine Theater), Coach David Perez (Rio Rancho High School), Jake Martinez (Rattlesnake Bar, Santa Fe). Paste the quote as a plain string — Klaviyo will HTML-escape it for the block.
  - Subject line: `How three New Mexico teams launched with FFMG`.
  - Preheader: `Recent projects from RRHS, Sunshine Theater, and a $2.5K web build.`

- `FFMG Express — Day 7 Re-engagement`
  - Body copied from `public/emails/express/03-re-engagement.html`.
  - Map `{{FIRST_NAME}}` to `$first_name`.
  - Subject line: `One last check-in on your FFMG Express request`.
  - Preheader: `Your open slot is held for 7 days — after that it moves to the next intake.`

## 4. Build the flow

1. **Flows → Create Flow → Build your own**.
2. Trigger: **Metric** → `FFMG Express Lead Submitted`.
3. Add three Email steps in this timeline:

   | Order | Step | Template | Time delay after trigger |
   |---|---|---|---|
   | 1 | Email | FFMG Express — Day 0 Acknowledgment | 0 days |
   | 2 | Email | FFMG Express — Day 3 Case Study | 3 days |
   | 3 | Email | FFMG Express — Day 7 Re-engagement | 7 days |

4. **Add a flow filter on each email step:** `Has not submitted FFMG intake form`. This exits any contact who converted (filled out `/intake`) from the drip — they don't get Day 3 / Day 7 emails.

5. Add a final **Conditional Split** after the Day 7 email that branches on whether the contact replied with `still interested` vs `not now` and tags each branch (`tag: still_interested` vs `tag: nurture_paused`) so the owner's manual follow-up queue can route on it later.

## 5. Sender identity

1. **Settings → Email → Sender Identity**.
2. From name: `Amer Child, Funk Factory Media Group`.
3. From email: `amer.child@funkfactorymediagroup.com`.
4. Reply-to: `amer.child@funkfactorymediagroup.com` (matches the footer copy and the `Reply "still interested" / "not now"` cue in Email 3).

## 6. Switch to Draft + request owner sign-off

1. In the flow editor, click **Review & Send** on each email. Verify the rendered preview against `https://funkfactoryos.polsia.app/emails/express/_preview.html`.
2. Switch the flow status to **Draft** (NOT Live).
3. Ping Amer for sign-off via the admin dashboard notification bell.

**Do not flip the flow to Live from this checklist.** Sign-off + Live switch happens together once Amer confirms the renders look right.

## 7. Notes for the deployed app

- `KLAVIYO_WEBHOOK_URL` in the Polsia env should be **left empty in production** until the flow goes live. The app's `recordSend` table fills regardless so the attribution dashboard at `/dashboard/ffmg-express` tracks deltas accurately even when the webhook isn't wired.
- When the flow goes Live, set `KLAVIYO_WEBHOOK_URL` to the Klaviyo inbound webhook URL that maps `Track Event` payloads to the matching metric. The webhook MUST accept the three event names from `EVENT_NAME_BY_DAYS_AGO` in `jobs/express-lead-nurture-daily.js` (`FFMG Express Lead Submitted`, `FFMG Express Lead Day 3`, `FFMG Express Lead Day 7`).
- The server-side cron (`jobs/express-lead-nurture-daily.js`, scheduled `0 14 * * *` in `polsia.toml`) is the source of truth for "did this contact get Day 3 / Day 7?" — Klaviyo's own delivery dashboard is secondary. If the two diverge (e.g. Klaviyo shows a Day 3 send but `express_nurture_sends` doesn't), the cause is almost always a webhook outage, not a flow config drift.

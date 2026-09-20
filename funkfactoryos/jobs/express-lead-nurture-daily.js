// Daily FFMG Express Stage 2 / Stage 3 nurture dispatcher.
//
// Runs as a standalone node process via [[crons]] in polsia.toml.
// Bootstrap: reuse the application pool, require db/express-nurture for candidate
// lookups + send-timestamp recording, then for each day-offset (default 3
// and 7) POST a Klaviyo Track Event to KLAVIYO_WEBHOOK_URL for every contact
// that hit POST /api/contact N days ago and has neither (a) converted into
// intake_submissions nor (b) already received the matching stage. Records
// the send timestamp per (contact_id, stage). Must not run as a long-lived
// worker — exits 0 when the loop completes.
//
// Idempotent:
//   - candidate query excludes any contact whose (contact_id, stage) row
//     already exists in express_nurture_sends
//   - recordSend uses ON CONFLICT DO NOTHING so a re-fire doesn't double-write
'use strict';

const pool = require('../db');
const webhook = process.env.KLAVIYO_WEBHOOK_URL;

const EVENT_NAME_BY_DAYS_AGO = {
  3: 'FFMG Express Lead Day 3',
  7: 'FFMG Express Lead Day 7'
};

const DEFAULT_OFFSETS = [3, 7];
let poolClosed = false;

async function closePool() {
  if (poolClosed) return;
  poolClosed = true;
  await pool.end();
}

function parseOffsets() {
  const raw = process.env.NURTURE_OFFSETS;
  if (!raw) return DEFAULT_OFFSETS;
  const parsed = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
  return parsed.length ? parsed : DEFAULT_OFFSETS;
}

async function postEventForContact(contact, daysAgo) {
  const event = EVENT_NAME_BY_DAYS_AGO[daysAgo];
  if (!webhook) return { skipped: 'missing_configuration', eventId: null };
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        email: contact.email,
        first_name: (contact.name || '').trim().split(/\s+/)[0] || '',
        contact_id: contact.contact_id,
        days_ago: daysAgo
      }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return { error: `http_${res.status}`, eventId: null };
    let eventId = null;
    try {
      const data = await res.json();
      eventId = data.event_id || data.id || null;
    } catch (_) { /* response wasn't JSON — recordSend tolerates null */ }
    return { skipped: null, eventId };
  } catch (err) {
    return { error: `error: ${err.message}`, eventId: null };
  }
}

async function runStage(daysAgo) {
  // Use the named nurture queries, which share the application pool.
  const { queueableContactsForDay, recordSend, windowStats } = require('../db/express-nurture');
  const stats = await windowStats(daysAgo);
  const candidates = await queueableContactsForDay(daysAgo);
  const eventName = EVENT_NAME_BY_DAYS_AGO[daysAgo];

  let sent = 0;
  let errors = 0;
  let skipped_no_webhook = 0;

  if (!webhook) {
    // No live webhook — don't fire-record the contacts; let the next tick
    // pick them up once the webhook is configured. Operators see the
    // candidate count but `sent` stays 0.
    skipped_no_webhook = candidates.length;
    for (const contact of candidates) {
      console.log(JSON.stringify({
        tag: 'express-nurture-skip',
        stage: daysAgo,
        event: eventName,
        contact_id: contact.contact_id,
        email: contact.email,
        reason: 'missing_configuration',
        missing: 'KLAVIYO_WEBHOOK_URL'
      }));
    }
  } else {
    for (const contact of candidates) {
      const { error, eventId } = await postEventForContact(contact, daysAgo);
      if (error) {
        errors += 1;
        console.error(`[Express Nurture] Stage ${daysAgo} dispatch error for ${contact.email}: ${error}`);
        continue;
      }
      try {
        await recordSend(contact.contact_id, daysAgo, eventId);
        sent += 1;
      } catch (err) {
        errors += 1;
        console.error(`[Express Nurture] Stage ${daysAgo} recordSend error for ${contact.email}: ${err.message}`);
      }
    }
  }

  return {
    stage: daysAgo,
    event: eventName,
    candidates: stats.candidates,
    sent,
    skipped_already_converted: stats.already_converted,
    skipped_already_sent: stats.already_sent,
    skipped_no_webhook: skipped_no_webhook,
    errors
  };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[Express Nurture] Cron tick @ ${today}`);

  const offsets = parseOffsets();
  console.log(`[Express Nurture] Offsets: ${offsets.join(', ')} (webhook=${webhook ? 'set' : 'unset'})`);

  const summaries = [];
  for (const daysAgo of offsets) {
    if (!EVENT_NAME_BY_DAYS_AGO[daysAgo]) {
      console.warn(`[Express Nurture] Skipping offset ${daysAgo} — no event mapping`);
      continue;
    }
    const summary = await runStage(daysAgo);
    console.log(JSON.stringify({ tag: 'express-nurture', ...summary }));
    summaries.push(summary);
  }

  const errors = summaries.reduce((total, summary) => total + summary.errors, 0);
  if (errors > 0) {
    throw new Error(`[Express Nurture] ${errors} configured dispatch or recordSend error(s); unsent candidates remain retryable.`);
  }

  console.log(`[Express Nurture] Done. ${summaries.length} stage(s) processed.`);
}

main()
  .then(async () => { await closePool(); process.exit(0); })
  .catch(async err => {
    console.error('[Express Nurture] Cron failed:', err.message);
    try { await closePool(); } catch (_) { /* ignore */ }
    process.exit(1);
  });

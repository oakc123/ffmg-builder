// Owns: client intake form API (POST /api/intake) + FFMG page routes (/, /intake, /what-we-offer, /services)
// Does NOT own: contact/booking form (contact.js), pets, admin
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const fetch = require('node-fetch');
const { createCustomer } = require('../db/customers');
const { createIntakeSubmission } = require('../db/intake-submissions');

// Multer config for intake (logo + up to 5 reference images)
// fieldSize raised to 50MB: images_meta contains base64-encoded images as a JSON string,
// which can easily exceed multer's 1MB default for non-file fields.
const intakeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, fieldSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml', 'application/pdf', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type'));
  }
});

const intakeFields = intakeUpload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'image_1', maxCount: 1 },
  { name: 'image_2', maxCount: 1 },
  { name: 'image_3', maxCount: 1 },
  { name: 'image_4', maxCount: 1 },
  { name: 'image_5', maxCount: 1 }
]);

// Fire-and-forget webhook POST — failures never break the user-facing submission
async function notifyWebhook(payload) {
  const WEBHOOK_URL = 'https://intake.funkfactorymediagroup.com/jobs/intake';
  const WEBHOOK_SECRET = 'ffmg-intake-2026';
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Polsia-Secret': WEBHOOK_SECRET
      },
      body: JSON.stringify(payload),
      // 8-second timeout so a slow endpoint doesn't hang the worker process
      timeout: 8000
    });
    if (!res.ok) {
      console.error(`[Intake] Webhook responded ${res.status} — submission still saved`);
    } else {
      console.log(`[Intake] Webhook delivered successfully`);
    }
  } catch (err) {
    console.error(`[Intake] Webhook error (non-fatal): ${err.message}`);
  }
}

// Fire-and-forget Klaviyo Identify — stamps UTM source/medium/campaign onto the
// contact's profile so leads surface in Klaviyo's source-level segmentation.
// Mirrors triggerStage1's webhook pattern in routes/contact.js (no recordSend
// row — the nurture-drip exclusion at db/express-nurture.js already keys off
// contact_submissions membership, so this call is purely for segmentation).
async function syncKlaviyoProfile({ email, first_name, utm_source, utm_medium, utm_campaign }) {
  const webhook = process.env.KLAVIYO_WEBHOOK_URL;
  if (!webhook) {
    console.log(`[Intake Klaviyo] KLAVIYO_WEBHOOK_URL unset — skipping profile sync for ${email}`);
    return;
  }
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'FFMG Express Intake Submitted',
        email,
        first_name,
        utm_source: utm_source || null,
        utm_medium: utm_medium || null,
        utm_campaign: utm_campaign || null
      }),
      timeout: 5000
    });
    if (!res.ok) {
      console.error(`[Intake Klaviyo] webhook returned ${res.status} for ${email}`);
    } else {
      console.log(`[Intake Klaviyo] profile synced for ${email}`);
    }
  } catch (err) {
    console.error(`[Intake Klaviyo] dispatch error for ${email}: ${err.message}`);
  }
}

// Backend fallback: generate a job_id slug if the frontend didn't send one
function generateJobIdFallback(businessName) {
  if (!businessName) return 'unknown-' + Math.floor(1000 + Math.random() * 9000);
  const slug = businessName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return (slug || 'unknown') + '-' + rand;
}

function trimInput(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── API ROUTE ─────────────────────────────────────────────────────────────────
// Mounted at /api/intake in server.js, so this is POST /
router.post('/', intakeFields, async (req, res) => {
  try {
    // Frontend now sends full_name instead of name; fall back to name for compat
    const full_name = trimInput(req.body.full_name) || trimInput(req.body.name);
    const {
      email: rawEmail, phone: rawPhone, business_name: rawBusinessName, industry: rawIndustry,
      existing_website: rawExistingWebsite, package: rawPackage, timeline: rawTimeline,
      description: rawDescription, budget_confirm: rawBudgetConfirm, competitors: rawCompetitors,
      color1: rawColor1, color2: rawColor2, color3: rawColor3, fonts: rawFonts,
      style_pref: rawStylePref, additional_notes: rawAdditionalNotes,
      submitted_at: rawSubmittedAt, source_url: rawSourceUrl, source: rawSource,
      customer_uuid: rawCustomerUuid, target_audience: rawTargetAudience,
      utm_source: rawUtmSource, utm_medium: rawUtmMedium, utm_campaign: rawUtmCampaign,
      ffmg_express_cta_variant: rawExpressCtaVariant, cta_variant: rawCtaVariant,
      pricing_variant_source: rawPricingVariantSource
    } = req.body;

    const email = trimInput(rawEmail);
    const phone = trimInput(rawPhone);
    const business_name = trimInput(rawBusinessName);
    const industry = trimInput(rawIndustry);
    const existing_website = trimInput(rawExistingWebsite);
    const pkg = trimInput(rawPackage);
    const timeline = trimInput(rawTimeline);
    const description = trimInput(rawDescription);
    const budget_confirm = trimInput(rawBudgetConfirm);
    const competitors = trimInput(rawCompetitors);
    const color1 = trimInput(rawColor1);
    const color2 = trimInput(rawColor2);
    const color3 = trimInput(rawColor3);
    const fonts = trimInput(rawFonts);
    const style_pref = trimInput(rawStylePref);
    const additional_notes = trimInput(rawAdditionalNotes);
    const submitted_at = trimInput(rawSubmittedAt);
    const source_url = trimInput(rawSourceUrl);
    const source = trimInput(rawSource);
    const customer_uuid = trimInput(rawCustomerUuid);
    const target_audience = trimInput(rawTargetAudience);
    const utm_source = trimInput(rawUtmSource);
    const utm_medium = trimInput(rawUtmMedium);
    const utm_campaign = trimInput(rawUtmCampaign);
    const ffmg_express_cta_variant = trimInput(rawExpressCtaVariant);
    const cta_variant = trimInput(rawCtaVariant);
    const pricing_variant_source = trimInput(rawPricingVariantSource);

    const fieldErrors = {};
    if (!full_name) fieldErrors.full_name = 'Client name is required.';
    if (!email) fieldErrors.email = 'Email is required.';
    else if (!EMAIL_PATTERN.test(email)) fieldErrors.email = 'Enter a valid email address.';
    if (!business_name) fieldErrors.business_name = 'Company name is required.';
    if (!pkg) fieldErrors.package = 'Project type is required.';
    if (!description) fieldErrors.description = 'Project brief is required.';

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Please correct the highlighted fields.',
        fields: fieldErrors
      });
    }

    // URL `variant` wins over sessionStorage carry — survives sessionStorage wipes
    const variant = (cta_variant || ffmg_express_cta_variant || '').trim().slice(0, 20) || null;

    // pricing_variant_source is a typed tag (linkedin|twitter|direct) — validate against allowlist so
    // anything else (e.g. tampering) is dropped to NULL and won't skew the per-source funnel dashboard.
    const allowedVariants = new Set(['linkedin', 'twitter', 'direct', 'google']);
    const safePricingVariant = pricing_variant_source && allowedVariants.has(String(pricing_variant_source))
      ? String(pricing_variant_source).slice(0, 20)
      : null;

    // Ensure job_id is valid — regenerate server-side if frontend sent empty/null
    let job_id = trimInput(req.body.job_id);
    if (!job_id || job_id === 'null' || job_id === 'undefined' || job_id === '-') {
      job_id = generateJobIdFallback(business_name);
      console.log(`[Intake] Regenerated job_id server-side: ${job_id} (business: ${business_name})`);
    }

    const hasLogo = !!(req.files && req.files.logo && req.files.logo[0]);
    const logoFile = hasLogo ? req.files.logo[0] : null;
    // Primary: client-side base64 from FormData field. Fallback: extract from multer buffer.
    const logoBase64 = req.body.logo_base64
      || (logoFile && logoFile.buffer ? logoFile.buffer.toString('base64') : null);
    const logoFilename = req.body.logo_filename
      || (logoFile ? logoFile.originalname : null);
    const logoContentType = req.body.logo_content_type
      || (logoFile ? logoFile.mimetype : null);
    const imageCount = req.files ? ['image_1','image_2','image_3','image_4','image_5']
      .filter(k => req.files[k] && req.files[k][0]).length : 0;

    const submission = await createIntakeSubmission({
      name: full_name,
      email,
      phone: phone || null,
      businessName: business_name,
      existingWebsite: existing_website || null,
      packageName: pkg || null,
      timeline: timeline || null,
      description,
      budgetConfirm: budget_confirm || null,
      competitors: competitors || null,
      color1: color1 || null,
      color2: color2 || null,
      color3: color3 || null,
      fonts: fonts || null,
      stylePref: style_pref || null,
      additionalNotes: additional_notes || null,
      hasLogo,
      imageCount,
      sourceUrl: source_url || null,
      submittedAt: submitted_at ? new Date(submitted_at) : new Date(),
      customerUuid: customer_uuid || null,
      jobId: job_id,
      targetAudience: target_audience || null,
      utmSource: utm_source || null,
      utmMedium: utm_medium || null,
      utmCampaign: utm_campaign || null,
      ctaVariant: variant,
      pricingVariantSource: safePricingVariant
    });

    // Create customer portal record so magic link auth can find them
    if (customer_uuid) {
      try {
        await createCustomer({
          customerUuid: customer_uuid,
          name: full_name,
          email,
          businessName: business_name,
          packageTier: pkg,
          jobId: job_id
        });
        console.log(`[Intake] Customer portal record created for ${email} — uuid: ${customer_uuid}`);
      } catch (customerErr) {
        // Non-fatal: intake submission succeeded; customer record failure just means no portal access yet
        console.error(`[Intake] Failed to create customer record (non-fatal): ${customerErr.message}`);
      }
    }

    console.log(`[Intake] New submission from ${full_name} <${email}> — package: ${pkg}, job_id: ${job_id}`);

    // Build image metadata array — merge file info from multer with client-side validated dimensions
    // Client sends images_meta as JSON: array of {width, height, size_bytes, format, validation} or null per slot
    let imagesMeta = [];
    try {
      if (req.body.images_meta) {
        imagesMeta = JSON.parse(req.body.images_meta);
      }
    } catch (e) {
      console.error('[Intake] Failed to parse images_meta:', e.message);
    }

    const imageUrls = [];
    for (let i = 0; i < 5; i++) {
      const key = 'image_' + (i + 1);
      const file = req.files && req.files[key] && req.files[key][0];
      if (file) {
        const meta = imagesMeta[i] || {};
        const fmt = file.mimetype === 'image/png' ? 'png'
          : file.mimetype === 'image/webp' ? 'webp'
          : 'jpg';
        // Primary: extract base64 from multer's in-memory buffer (always available with memoryStorage).
        // Fallback: client-side base64 from images_meta JSON field (unreliable for large payloads).
        const base64FromBuffer = file.buffer ? file.buffer.toString('base64') : '';
        const base64Value = base64FromBuffer || meta.base64 || '';
        imageUrls.push({
          filename: file.originalname,
          width: meta.width || 0,
          height: meta.height || 0,
          size_bytes: meta.size_bytes || file.size,
          format: meta.format || fmt,
          validation: meta.validation || 'pass',
          base64: base64Value
        });
      }
    }

    // Non-blocking webhook — fire and forget, DB save already succeeded
    // Payload structure matches what intake.funkfactorymediagroup.com expects exactly:
    // contact.full_name (NOT name), contact.industry required, no existing_website in contact
    const webhookPayload = {
      job_id: job_id,
      source: source || 'polsia-intake',
      submitted_at: submitted_at || new Date().toISOString(),
      customer_uuid: customer_uuid || null,
      package: pkg || null,
      contact: {
        full_name: full_name,
        business_name: business_name,
        industry: industry || null,
        email: email,
        phone: phone || null
      },
      project: {
        goal: description,
        target_audience: target_audience || '',
        pages: [],
        tone: style_pref ? [style_pref] : [],
        has_existing_website: !!(existing_website && existing_website.trim()),
        existing_website_url: existing_website || '',
        inspiration_urls: competitors
          ? competitors.split('\n').map(u => u.trim()).filter(Boolean)
          : []
      },
      brand: {
        colors: [color1 || null, color2 || null, color3 || null].filter(Boolean),
        fonts: fonts || null,
        style_pref: style_pref || null,
        has_logo: hasLogo,
        ...(logoBase64 ? {
          logo_filename: logoFilename,
          logo_base64: logoBase64,
          logo_content_type: logoContentType
        } : {})
      },
      images: imageUrls,
      delivery: {
        timeline: timeline || null
      },
      domain: {
        existing_website: existing_website || null
      },
      notes: additional_notes || null,
      utm: {
        utm_source:   utm_source || null,
        utm_medium:   utm_medium || null,
        utm_campaign: utm_campaign || null
      }
    };

    // Log base64 lengths (not full data) for debugging — confirms data survives multer + JSON parse
    const imgSummary = imageUrls.map((img, i) => `image_${i+1}: base64=${(img.base64 || '').length} chars, file=${img.filename}`);
    console.log(`[Intake] Image base64 summary: ${imgSummary.length ? imgSummary.join('; ') : 'no images'}`);
    if (webhookPayload.brand.logo_base64) {
      console.log(`[Intake] Logo base64: ${webhookPayload.brand.logo_base64.length} chars`);
    }
    notifyWebhook(webhookPayload);

    syncKlaviyoProfile({
      email,
      first_name: (full_name || '').trim().split(/\s+/)[0] || '',
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null
    }).catch((err) => console.error('[Intake Klaviyo] sync outer error:', err.message));

    res.json({
      success: true,
      message: 'Intake submission received successfully.',
      id: submission.id,
      created_at: submission.created_at,
      customer_uuid: customer_uuid || null
    });
  } catch (err) {
    console.error('[Intake] Error:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;

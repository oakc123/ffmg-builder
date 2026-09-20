// Owns: intake_submissions table queries
// Does NOT own: raw PostgreSQL pool construction (db/index.js), intake request handling (routes/intake.js)
const pool = require('./index');

async function createIntakeSubmission({
  name,
  email,
  phone,
  businessName,
  existingWebsite,
  packageName,
  timeline,
  description,
  budgetConfirm,
  competitors,
  color1,
  color2,
  color3,
  fonts,
  stylePref,
  additionalNotes,
  hasLogo,
  imageCount,
  sourceUrl,
  submittedAt,
  customerUuid,
  jobId,
  targetAudience,
  utmSource,
  utmMedium,
  utmCampaign,
  ctaVariant,
  pricingVariantSource
}) {
  const { rows } = await pool.query(
    `INSERT INTO intake_submissions
      (name, email, phone, business_name, existing_website, package, timeline,
       description, budget_confirm, competitors, color1, color2, color3,
       fonts, style_pref, additional_notes, has_logo, image_count, source_url, submitted_at,
       customer_uuid, job_id, target_audience,
       utm_source, utm_medium, utm_campaign, cta_variant, pricing_variant_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     RETURNING id, created_at`,
    [name, email, phone, businessName, existingWebsite,
      packageName, timeline, description, budgetConfirm,
      competitors, color1, color2, color3,
      fonts, stylePref, additionalNotes,
      hasLogo, imageCount, sourceUrl,
      submittedAt, customerUuid, jobId, targetAudience,
      utmSource, utmMedium, utmCampaign,
      ctaVariant, pricingVariantSource]
  );
  return rows[0];
}

async function getIntakeSubmissions() {
  const { rows } = await pool.query(
    `SELECT id, name, business_name, package, budget_confirm, timeline, description, created_at, status
     FROM intake_submissions
     ORDER BY created_at DESC, id DESC`
  );
  return rows;
}

async function updateIntakeSubmissionStatus(id, status) {
  const { rows } = await pool.query(
    `UPDATE intake_submissions
     SET status = $2
     WHERE id = $1
     RETURNING id, status`,
    [id, status]
  );
  return rows[0] || null;
}

module.exports = { createIntakeSubmission, getIntakeSubmissions, updateIntakeSubmissionStatus };

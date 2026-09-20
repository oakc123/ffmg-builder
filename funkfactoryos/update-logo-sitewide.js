#!/usr/bin/env node
/**
 * update-logo-sitewide.js
 * Replaces all nav logo inline SVGs and updates favicon + og:image
 * across all non-pets FFMG HTML pages.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, 'public');

// ── New nav logo HTML (replaces inline SVG + text) ──
const NEW_NAV_LOGO_IMG = '<img src="/images/ffmg-logo.svg" alt="Funk Factory Media Group" height="44" style="display:inline-block;vertical-align:middle;">';

// ── New favicon (FFMG badge: circular, FFMG letters, copper+brown) ──
// A simplified badge icon for 32x32
const NEW_FAVICON_SVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%236B3A1F' stroke='%23D4956A' stroke-width='1.5'/%3E%3Ctext x='4' y='13' font-family='Arial Black,Arial' font-weight='900' font-size='8' fill='%23D4956A'%3EFF%3C/text%3E%3Ctext x='4' y='23' font-family='Arial Black,Arial' font-weight='900' font-size='8' fill='%23D4956A'%3EMG%3C/text%3E%3C/svg%3E`;

const NEW_FAVICON_TAG = `<link rel="icon" type="image/svg+xml" href="${NEW_FAVICON_SVG}">`;

// ── New og:image (will be set to the PNG we upload, using placeholder for now) ──
const OG_IMAGE_URL = 'https://funkfactoryos.polsia.app/images/ffmg-logo.svg';

// Files to update (non-pets, non-admin FFMG pages)
const FFMG_PAGES = [
  'index.html',
  'about.html',
  'services.html',
  'portfolio.html',
  'contact.html',
  'what-we-offer.html',
  'intake.html',
  'portal.html',
  'blog/index.html',
  'blog/concert-videographer-albuquerque.html',
  'blog/event-photography-packages-new-mexico.html',
];

let totalChanges = 0;

for (const relPath of FFMG_PAGES) {
  const filePath = path.join(PUBLIC, relPath);
  if (!fs.existsSync(filePath)) {
    console.warn(`  SKIP (not found): ${relPath}`);
    continue;
  }

  let html = fs.readFileSync(filePath, 'utf8');
  let changes = 0;

  // ── 1. Replace favicon link ──
  const oldFaviconRe = /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml[^"]*">/g;
  if (oldFaviconRe.test(html)) {
    html = html.replace(/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml[^"]*">/g, NEW_FAVICON_TAG);
    changes++;
    console.log(`  [favicon] replaced in ${relPath}`);
  }

  // ── 2. Replace og:image ──
  const ogImageRe = /<meta property="og:image" content="[^"]*">/g;
  if (ogImageRe.test(html)) {
    html = html.replace(/<meta property="og:image" content="[^"]*">/g,
      `<meta property="og:image" content="${OG_IMAGE_URL}">`);
    changes++;
    console.log(`  [og:image] replaced in ${relPath}`);
  }

  // ── 3. Replace nav logo - Pattern A (32px SVG with span text) ──
  // Matches: <svg width="32" height="32" ... (multiline SVG) ... </svg>\n            <span ...>...</span>
  const navLogoPatternA = /<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http:\/\/www\.w3\.org\/2000\/svg" style="[^"]*">[\s\S]*?<\/svg>\s*\n\s*<span style="[^"]*">[\s\S]*?<\/span>/g;
  if (navLogoPatternA.test(html)) {
    html = html.replace(navLogoPatternA, NEW_NAV_LOGO_IMG);
    changes++;
    console.log(`  [nav-logo PatA] replaced in ${relPath}`);
  }

  // ── 4. Replace nav logo - Pattern B (28px SVG + bare text) ──
  // Matches: <svg width="28" ...></svg>\n            Funk Factory <span>MG</span>
  const navLogoPatternB = /<svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http:\/\/www\.w3\.org\/2000\/svg">[\s\S]*?<\/svg>\s*\n\s*Funk Factory <span>MG<\/span>/g;
  if (navLogoPatternB.test(html)) {
    html = html.replace(navLogoPatternB, NEW_NAV_LOGO_IMG);
    changes++;
    console.log(`  [nav-logo PatB] replaced in ${relPath}`);
  }

  // ── 5. Footer brand inline SVG replacement ──
  // footer-brand div contains similar inline SVG
  const footerLogoRe = /<svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http:\/\/www\.w3\.org\/2000\/svg" style="[^"]*">[\s\S]*?<\/svg>/g;
  if (footerLogoRe.test(html)) {
    html = html.replace(footerLogoRe,
      '<img src="/images/ffmg-logo.svg" alt="FFMG" height="28" style="display:inline-block;vertical-align:middle;margin-right:6px;">');
    changes++;
    console.log(`  [footer-logo] replaced in ${relPath}`);
  }

  // ── 6. JSON-LD logo URL (blog pages) ──
  const jsonLdLogoRe = /"logo":\s*\{[\s\S]*?"url":\s*"https:\/\/funkfactoryos\.polsia\.app\/favicon\.ico"[\s\S]*?\}/g;
  if (jsonLdLogoRe.test(html)) {
    html = html.replace(/"url":\s*"https:\/\/funkfactoryos\.polsia\.app\/favicon\.ico"/g,
      `"url": "https://funkfactoryos.polsia.app/images/ffmg-logo.svg"`);
    changes++;
    console.log(`  [json-ld logo] replaced in ${relPath}`);
  }

  if (changes > 0) {
    fs.writeFileSync(filePath, html, 'utf8');
    console.log(`  ✓ ${relPath} — ${changes} change(s) written`);
  } else {
    console.log(`  ~ ${relPath} — no changes needed`);
  }
  totalChanges += changes;
}

console.log(`\nDone. Total change blocks applied: ${totalChanges}`);

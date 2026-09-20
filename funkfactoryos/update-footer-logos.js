#!/usr/bin/env node
/**
 * update-footer-logos.js
 * Replaces remaining text-only footer logos with the SVG image.
 */

const fs = require('fs');

const NEW_FOOTER_LOGO = '<img src="/images/ffmg-logo.svg" alt="Funk Factory Media Group" height="32" style="display:inline-block;vertical-align:middle;">';

// Pattern 1: footer nav-logo with text
const FOOTER_TEXT_LOGO = /<a href="\/" class="nav-logo" style="[^"]*">\s*\n\s*Funk Factory <span style="[^"]*">MG<\/span>\s*\n\s*<\/a>/g;

// Pattern 2: footer-brand-name div (portfolio)
const FOOTER_BRAND_NAME = /<div class="footer-brand-name">Funk<span>Factory<\/span> MG<\/div>/g;

const FILES = [
  '/opt/polsia/funkfactoryos/public/about.html',
  '/opt/polsia/funkfactoryos/public/contact.html',
  '/opt/polsia/funkfactoryos/public/portfolio.html',
  '/opt/polsia/funkfactoryos/public/blog/index.html',
  '/opt/polsia/funkfactoryos/public/blog/concert-videographer-albuquerque.html',
  '/opt/polsia/funkfactoryos/public/blog/event-photography-packages-new-mexico.html',
  '/opt/polsia/funkfactoryos/public/services.html',
  '/opt/polsia/funkfactoryos/public/what-we-offer.html',
];

for (const f of FILES) {
  if (!fs.existsSync(f)) { console.log(`SKIP: ${f}`); continue; }
  let html = fs.readFileSync(f, 'utf8');
  let changes = 0;

  if (FOOTER_TEXT_LOGO.test(html)) {
    html = html.replace(FOOTER_TEXT_LOGO,
      `<a href="/" class="nav-logo" style="color:rgba(255,255,255,0.85);text-decoration:none;display:inline-flex;align-items:center;gap:8px;margin-bottom:10px;">${NEW_FOOTER_LOGO}</a>`);
    changes++;
    console.log(`  [footer text logo] ${f}`);
  }
  FOOTER_TEXT_LOGO.lastIndex = 0;

  if (FOOTER_BRAND_NAME.test(html)) {
    html = html.replace(FOOTER_BRAND_NAME,
      `<div class="footer-brand-name">${NEW_FOOTER_LOGO}</div>`);
    changes++;
    console.log(`  [footer-brand-name] ${f}`);
  }
  FOOTER_BRAND_NAME.lastIndex = 0;

  if (changes > 0) {
    fs.writeFileSync(f, html, 'utf8');
    console.log(`  ✓ written ${f}`);
  } else {
    console.log(`  ~ no match ${f}`);
  }
}
console.log('Done.');

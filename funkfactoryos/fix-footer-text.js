#!/usr/bin/env node
const fs = require('fs');

const FILES = [
  '/opt/polsia/funkfactoryos/public/index.html',
  '/opt/polsia/funkfactoryos/public/services.html',
  '/opt/polsia/funkfactoryos/public/what-we-offer.html',
];

for (const f of FILES) {
  let html = fs.readFileSync(f, 'utf8');
  // Remove the bare "Funk<span>Factory</span> Media Group" text after the footer img
  const before = html.length;
  html = html.replace(
    /(<img src="\/images\/ffmg-logo\.svg" alt="FFMG" height="28"[^>]*>)\s*\n\s*Funk<span>Factory<\/span> Media Group/g,
    '$1'
  );
  if (html.length !== before) {
    fs.writeFileSync(f, html, 'utf8');
    console.log('fixed:', f);
  } else {
    console.log('no change:', f);
  }
}

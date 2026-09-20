const express = require('express');
const path = require('path');

const router = express.Router();
const notFoundPath = path.join(__dirname, '..', 'public', '404.html');
const passthroughPrefixes = ['/api', '/admin', '/dashboard', '/pets'];

function renderNotFound(req, res) {
  return res.status(404).type('html').sendFile(notFoundPath);
}

function isBrowserHtmlRequest(req) {
  const accept = req.get('accept') || '';
  if (req.method !== 'GET' || (accept && !req.accepts('html'))) return false;
  if (path.extname(req.path)) return false;
  return !passthroughPrefixes.some((prefix) => (
    req.path === prefix || req.path.startsWith(prefix + '/')
  ));
}

router.use((req, res, next) => {
  if (!isBrowserHtmlRequest(req)) return next();
  return renderNotFound(req, res);
});

module.exports = router;
module.exports.renderNotFound = renderNotFound;

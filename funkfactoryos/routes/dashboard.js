// Owns: authenticated admin dashboard page shells
// Does NOT own: API authentication or submission data (routes/admin-portal.js)
'use strict';

const express = require('express');
const path = require('path');
const router = express.Router();

router.get('/intake', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'intake.html'));
});

module.exports = router;

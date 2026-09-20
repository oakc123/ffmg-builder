// Owns: magic link auth endpoints (POST /api/auth/magic-link, POST /api/auth/verify-token)
// Does NOT own: customer data model (db/customers.js), messaging (routes/messages.js)
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fetch = require('node-fetch');
const {
  findCustomerByEmailAndUUID,
  storeMagicLinkToken,
  findMagicLinkToken,
  markTokenUsed
} = require('../db/customers');

const SECRET = process.env.MAGIC_LINK_SECRET || 'REDACTED';
const BASE_URL = process.env.PORTAL_BASE_URL || 'https://funkfactoryos.polsia.app';

// Sign a payload using HMAC-SHA256 — returns base64url token
function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Verify a token string — returns parsed payload or null
function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    if (!data || !sig) return null;
    const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
    // Constant-time compare
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch {
    return null;
  }
}

// Hash a token for DB storage — we never store the raw token
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function sendMagicLinkEmail(email, magicLink) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: 'DM Sans', Arial, sans-serif; background: #faf6f1; margin: 0; padding: 40px 20px;">
      <div style="max-width: 520px; margin: 0 auto; background: #fff; border-radius: 12px; border: 1px solid rgba(107,58,31,0.12); padding: 40px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <svg width="40" height="40" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="6" fill="#6B3A1F"/>
            <text x="8" y="24" font-family="Arial Black,Arial" font-weight="900" font-size="22" fill="#D4956A">F</text>
          </svg>
        </div>
        <h1 style="color: #1a0f08; font-size: 22px; font-weight: 700; margin: 0 0 8px; text-align: center;">Your FFMG Project Login</h1>
        <p style="color: #6b5c50; font-size: 15px; line-height: 1.6; margin: 0 0 28px; text-align: center;">
          Click the button below to access your project portal. This link expires in 15 minutes.
        </p>
        <div style="text-align: center; margin-bottom: 28px;">
          <a href="${magicLink}" style="display: inline-block; background: #D4956A; color: #fff; text-decoration: none; font-weight: 600; font-size: 16px; padding: 14px 32px; border-radius: 8px;">
            Access My Project Portal →
          </a>
        </div>
        <p style="color: #6b5c50; font-size: 13px; text-align: center; margin: 0;">
          If you didn't request this, you can safely ignore this email.<br>
          This link can only be used once and expires in 15 minutes.
        </p>
        <div style="margin-top: 28px; padding-top: 20px; border-top: 1px solid rgba(107,58,31,0.1); text-align: center;">
          <p style="color: #9b8a7e; font-size: 12px; margin: 0;">
            Funk Factory Media Group · Albuquerque, NM
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  const res = await fetch('https://polsia.com/api/proxy/email/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.POLSIA_API_KEY}`
    },
    body: JSON.stringify({
      to: email,
      subject: 'Your FFMG project login link',
      body: `Access your FFMG project portal here: ${magicLink}\n\nThis link expires in 15 minutes.`,
      html
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Email send failed: ${res.status} ${text}`);
  }
}

// POST /api/auth/magic-link
// Body: { email, customer_uuid }
router.post('/magic-link', async (req, res) => {
  const { email, customer_uuid } = req.body;

  if (!email || !customer_uuid) {
    return res.status(422).json({ error: 'email and customer_uuid are required' });
  }

  const customer = await findCustomerByEmailAndUUID(email, customer_uuid).catch(() => null);
  if (!customer) {
    return res.status(404).json({ error: 'No matching account found. Please check your email and reference number.' });
  }

  const now = Date.now();
  const exp = now + 15 * 60 * 1000; // 15 minutes

  const payload = {
    customer_uuid: customer.customer_uuid,
    job_id: customer.job_id,
    email: customer.email,
    iat: now,
    exp
  };

  const token = signToken(payload);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(exp);

  try {
    await storeMagicLinkToken({
      tokenHash,
      customerUuid: customer.customer_uuid,
      jobId: customer.job_id,
      email: customer.email,
      expiresAt
    });
  } catch (err) {
    console.error('[Auth] Failed to store magic link token:', err.message);
    return res.status(500).json({ error: 'Failed to generate login link. Please try again.' });
  }

  const magicLink = `${BASE_URL}/portal?token=${encodeURIComponent(token)}`;

  try {
    await sendMagicLinkEmail(customer.email, magicLink);
  } catch (err) {
    console.error('[Auth] Failed to send magic link email:', err.message);
    return res.status(500).json({ error: 'Failed to send login email. Please try again.' });
  }

  console.log(`[Auth] Magic link sent to ${customer.email}`);
  res.json({ sent: true, email: customer.email });
});

// POST /api/auth/verify-token
// Body: { token }
router.post('/verify-token', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(401).json({ valid: false, reason: 'invalid' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ valid: false, reason: 'invalid' });
  }

  if (Date.now() > payload.exp) {
    return res.status(401).json({ valid: false, reason: 'expired' });
  }

  // Check DB record (ensures token wasn't revoked/used)
  const tokenHash = hashToken(token);
  const dbToken = await findMagicLinkToken(tokenHash).catch(() => null);
  if (!dbToken || dbToken.used) {
    return res.status(401).json({ valid: false, reason: dbToken?.used ? 'expired' : 'invalid' });
  }

  // Mark token as used — one-time use
  await markTokenUsed(tokenHash).catch(err => {
    console.error('[Auth] Failed to mark token used:', err.message);
  });

  // Session is valid for 7 days from now
  const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  res.json({
    valid: true,
    customer_uuid: payload.customer_uuid,
    job_id: payload.job_id,
    email: payload.email,
    expires_at: sessionExpires
  });
});

// Middleware for authenticated portal routes — validates Bearer token
function requirePortalAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const customerUuidHeader = req.headers['x-customer-uuid'];

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const payload = verifyToken(token);
  if (!payload || Date.now() > payload.exp + 7 * 24 * 60 * 60 * 1000) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  // Accept if customer_uuid matches header (or header absent — graceful for older clients)
  if (customerUuidHeader && customerUuidHeader !== payload.customer_uuid) {
    return res.status(403).json({ error: 'UUID mismatch' });
  }

  req.portal = payload;
  next();
}

module.exports = router;
module.exports.requirePortalAuth = requirePortalAuth;

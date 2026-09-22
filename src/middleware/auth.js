const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  throw new Error('JWT_SECRET must be set to a strong random value (see .env.example). Refusing to start with a weak/missing secret.');
}

// Zero-downtime secret rotation: set JWT_SECRET to the new value and
// JWT_SECRET_PREVIOUS to the old one. New tokens are signed with the new
// secret; sessions issued under the old one keep working until they expire
// (8h), so a rotation never interrupts an assessment in progress. Remove
// JWT_SECRET_PREVIOUS once that window has passed.
const JWT_SECRET_PREVIOUS = process.env.JWT_SECRET_PREVIOUS || null;
if (JWT_SECRET_PREVIOUS && JWT_SECRET_PREVIOUS === JWT_SECRET) {
  throw new Error('JWT_SECRET_PREVIOUS must differ from JWT_SECRET, otherwise rotation has not actually happened.');
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, role: user.role, tv: user.token_version || 0 },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

// Verify against the current secret, then the previous one during a rotation.
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    if (!JWT_SECRET_PREVIOUS) throw e;
    return jwt.verify(token, JWT_SECRET_PREVIOUS);
  }
}

// Requires a valid admin session (Bearer token). Populates req.user.
// This is the ONLY thing that grants access to any /api/admin/* route —
// there is no client-side-only gate anywhere in this system.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.cookies && req.cookies.lalco_admin_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const payload = verifyToken(token);
    // The account is re-checked on every request: a disabled account, a changed
    // role, or a password reset takes effect immediately rather than lingering
    // until the token expires.
    const db = require('../db');
    const user = db.prepare('SELECT id, name, role, active, token_version FROM users WHERE id = ?').get(payload.sub);
    if (!user || !user.active) {
      return res.status(401).json({ error: 'This account is no longer active. Please sign in again.' });
    }
    if ((payload.tv || 0) !== (user.token_version || 0)) {
      return res.status(401).json({ error: 'Your session has been ended. Please sign in again.' });
    }
    // Role comes from the database, not the token, so a demotion is immediate.
    req.user = { id: user.id, name: user.name, role: user.role };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Your role does not have access to this action.' });
    next();
  };
}

// Public exam endpoints are rate-limited per IP to reduce token brute-forcing /
// abuse, since these routes are reachable by anyone on the internet with a link.
//
// The ceiling has to stay well clear of legitimate traffic: one candidate
// autosaving while typing an essay produces a steady trickle of requests, and
// several candidates sitting in the same office share one public IP. The token
// space is 2^256, so a generous per-minute cap still leaves brute-forcing
// hopeless. Tune with EXAM_RATE_LIMIT_PER_MINUTE if a venue needs more.
const EXAM_RATE_LIMIT = Math.max(60, Number(process.env.EXAM_RATE_LIMIT_PER_MINUTE) || 300);
const examLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: EXAM_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});

const LOGIN_RATE_LIMIT = Math.max(5, Number(process.env.LOGIN_RATE_LIMIT_PER_15_MIN) || 20);
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: LOGIN_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

module.exports = { signToken, verifyToken, requireAuth, requireRole, examLimiter, loginLimiter, JWT_SECRET };

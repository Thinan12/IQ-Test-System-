const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  throw new Error('JWT_SECRET must be set to a strong random value (see .env.example). Refusing to start with a weak/missing secret.');
}

function signToken(user) {
  return jwt.sign({ sub: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
}

// Requires a valid admin session (Bearer token). Populates req.user.
// This is the ONLY thing that grants access to any /api/admin/* route —
// there is no client-side-only gate anywhere in this system.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.cookies && req.cookies.lalco_admin_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, name: payload.name, role: payload.role };
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

module.exports = { signToken, requireAuth, requireRole, examLimiter, loginLimiter, JWT_SECRET };

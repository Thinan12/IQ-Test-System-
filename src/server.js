require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const { startExpirySweeper, finalizeExpiredSessions } = require('./lib/finalize');

const app = express();
app.set('trust proxy', 1); // needed for correct req.ip behind a reverse proxy (rate limiting, audit logs)

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
    },
  },
  // HSTS: once a browser has seen this header it refuses plain HTTP for a year.
  hsts: IS_PRODUCTION ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
}));

// HTTPS is required in production. Behind a reverse proxy the original scheme
// arrives in X-Forwarded-Proto (trust proxy is set above), so a plain-HTTP
// request is redirected for browsers and refused for API clients — an exam
// token or admin JWT must never travel unencrypted.
if (IS_PRODUCTION && String(process.env.ALLOW_INSECURE_HTTP || '').toLowerCase() !== 'true') {
  app.use((req, res, next) => {
    // The platform health check can reach the container directly over plain
    // HTTP; redirecting it would fail the deployment for no security gain
    // (it returns nothing sensitive).
    if (req.path === '/api/health') return next();
    if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.redirect(308, 'https://' + req.get('host') + req.originalUrl);
    }
    return res.status(403).json({ error: 'HTTPS is required.' });
  });
}
// CORS. In production an explicit allow-list is required: leaving it open would
// let any site call the admin API with a stolen token. CORS_ORIGIN accepts one
// origin or a comma-separated list. With none set in production no cross-origin
// request is allowed at all — the bundled admin/exam SPAs are same-origin, so
// the app still works fully.
const ALLOWED_ORIGINS = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);            // same-origin / curl / server-to-server
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0 && !IS_PRODUCTION) return callback(null, true); // dev convenience only
    return callback(null, false);                        // no CORS headers -> browser blocks it
  },
  credentials: false,
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));

// ---- Health check ----
// Used by Railway/monitoring. Deliberately exposes nothing but liveness and
// whether the database answers a trivial query — no secrets, no paths, no
// credentials, no configuration values.
app.get('/api/health', (req, res) => {
  let database = 'disconnected';
  try {
    require('./db').prepare('SELECT 1 AS ok').get();
    database = 'connected';
  } catch (e) {
    database = 'disconnected';
  }
  const healthy = database === 'connected';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'error',
    database,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// ---- API routes ----
app.use('/api/admin/auth', require('./routes/admin/auth'));
app.use('/api/admin/candidates', require('./routes/admin/candidates'));
app.use('/api/admin/questions', require('./routes/admin/questions'));
app.use('/api/admin/links', require('./routes/admin/links'));
app.use('/api/admin/reports', require('./routes/admin/reports'));
// Mounted before the catch-all misc router so its Super-Admin-only guard
// applies to every /settings/data-management path.
app.use('/api/admin/settings/data-management', require('./routes/admin/dataManagement'));
app.use('/api/admin/users', require('./routes/admin/users'));
app.use('/api/admin/exam-control', require('./routes/admin/examControl'));
app.use('/api/admin', require('./routes/admin/misc'));
app.use('/api/exam', require('./routes/exam'));

// Shared static assets (e.g. shared.css) used by both frontends.
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// ---- Static frontends ----
// Private admin SPA — the API behind it is what actually enforces access (requireAuth),
// this static bundle contains no candidate answer keys or other candidates' data;
// each page fetches only what the logged-in user's role is authorized to see.
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));

// Public candidate exam SPA — contains no admin code, no answer keys, no other candidate data.
app.use('/exam', express.static(path.join(__dirname, '..', 'public', 'exam')));
app.get('/exam/:token', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'exam', 'index.html')));

app.get('/', (req, res) => res.redirect('/admin'));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// Fail loudly on misconfiguration rather than silently running an insecure
// production deployment.
if (IS_PRODUCTION) {
  if (ALLOWED_ORIGINS.length === 0) {
    console.warn('[config] CORS_ORIGIN is not set — cross-origin browser requests are blocked. Set it if the admin UI is served from a different origin.');
  }
  if (String(process.env.ALLOW_INSECURE_HTTP || '').toLowerCase() === 'true') {
    console.warn('[config] ALLOW_INSECURE_HTTP=true — HTTPS enforcement is DISABLED. Do not use this in production.');
  }
}

const PORT = process.env.PORT || 4000;
// Bind all interfaces: a container platform routes to the container's IP, not
// to loopback, so binding 127.0.0.1 would make the app unreachable.
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`LALCO Recruitment Platform listening on ${HOST}:${PORT}`);
  console.log(`  Health:     /api/health`);
  console.log(`  Admin:      /admin`);
  console.log(`  Exam links: /exam/<token>`);

  // Safety net for abandoned assessments: if a candidate walks away, no request
  // ever reaches the server from that browser, so nothing else would notice the
  // deadline passing. This sweep finalizes them so a session cannot sit in
  // IN_PROGRESS forever. Finalization is idempotent, so it can never produce a
  // second submission for a session already submitted another way.
  const sweeper = startExpirySweeper(process.env.AUTO_SUBMIT_SWEEP_SECONDS);
  console.log(`  Auto-submit sweep: every ${sweeper.intervalSeconds}s`);

  // Anything already past its deadline while the server was down.
  try {
    const caught = finalizeExpiredSessions();
    if (caught.finalized > 0) console.log(`  Auto-submitted ${caught.finalized} assessment(s) that expired while offline`);
  } catch (error) {
    console.error('[auto-submit] startup sweep failed:', error.message);
  }
});

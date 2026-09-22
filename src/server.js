require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');

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
    if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.redirect(308, 'https://' + req.get('host') + req.originalUrl);
    }
    return res.status(403).json({ error: 'HTTPS is required.' });
  });
}
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: false }));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));

// ---- API routes ----
app.use('/api/admin/auth', require('./routes/admin/auth'));
app.use('/api/admin/candidates', require('./routes/admin/candidates'));
app.use('/api/admin/questions', require('./routes/admin/questions'));
app.use('/api/admin/links', require('./routes/admin/links'));
app.use('/api/admin/reports', require('./routes/admin/reports'));
// Mounted before the catch-all misc router so its Super-Admin-only guard
// applies to every /settings/data-management path.
app.use('/api/admin/settings/data-management', require('./routes/admin/dataManagement'));
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
  if (!process.env.CORS_ORIGIN) {
    console.warn('[config] CORS_ORIGIN is not set — the admin API accepts any origin. Set it to your real admin URL.');
  }
  if (String(process.env.ALLOW_INSECURE_HTTP || '').toLowerCase() === 'true') {
    console.warn('[config] ALLOW_INSECURE_HTTP=true — HTTPS enforcement is DISABLED. Do not use this in production.');
  }
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`LALCO Recruitment Platform listening on http://localhost:${PORT}`);
  console.log(`  Admin:      http://localhost:${PORT}/admin`);
  console.log(`  Exam links: http://localhost:${PORT}/exam/<token>`);
});

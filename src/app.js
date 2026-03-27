// src/app.js
require('dotenv').config();

const express        = require('express');
const session        = require('express-session');
const pgSession      = require('connect-pg-simple')(session);
const helmet         = require('helmet');
const methodOverride = require('method-override');
const crypto         = require('crypto');
const path           = require('path');
const config         = require('../config/settings');
const { botRateLimit } = require('../middleware/rateLimit');
const adminRoutes    = require('../admin/routes/index');

const app = express();

// ─────────────────────────────────────────
// TRUST PROXY
// ─────────────────────────────────────────
app.set('trust proxy', 1);

// ─────────────────────────────────────────
// SECURITY HEADERS
// ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://fonts.googleapis.com',
        'https://cdn.jsdelivr.net',
      ],
      fontSrc: [
        "'self'",
        'https://fonts.gstatic.com',
        'https://cdn.jsdelivr.net',
      ],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://cdn.jsdelivr.net',
      ],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ─────────────────────────────────────────
// VIEW ENGINE
// ─────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../admin/views'));

// ─────────────────────────────────────────
// BODY PARSERS
// ─────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(methodOverride('_method'));

// ─────────────────────────────────────────
// STATIC FILES
// ─────────────────────────────────────────
app.use('/public', express.static(path.join(__dirname, '../public'), {
  maxAge: '1d',
  etag:   true,
}));

// ─────────────────────────────────────────
// SESSION — PostgreSQL Store
// ─────────────────────────────────────────
app.use(session({
  store: new pgSession({
    conString:            config.database.url,
    tableName:            'session',
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 15,
  }),
  secret:            config.app.sessionSecret,
  resave:            false,
  saveUninitialized: false,
  name:              'sid',
  cookie: {
    // ✅ secure: false حتى مع Railway — Railway يتعامل مع HTTPS خارجياً
    secure:   false,
    httpOnly: true,
    maxAge:   config.security.sessionMaxAge,
    sameSite: 'lax',
  },
}));

// ─────────────────────────────────────────
// CSRF — Session-based (أبسط وأكثر موثوقية)
// ─────────────────────────────────────────

// توليد token وتخزينه في الـ session
function generateCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

// middleware للتحقق من الـ token في POST requests
function csrfProtection(req, res, next) {
  // تجاهل GET, HEAD, OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const sessionToken = req.session.csrfToken;
  const bodyToken    = req.body._csrf || req.headers['x-csrf-token'];

  if (!sessionToken || !bodyToken || sessionToken !== bodyToken) {
    if (global.logger) {
      global.logger.warn('[CSRF] Invalid token from ' + req.ip + ' — path: ' + req.path);
    }
    req.session.error = 'انتهت صلاحية الجلسة. يرجى المحاولة مجدداً.';
    return res.redirect('/admin/login');
  }

  // تجديد الـ token بعد كل POST ناجح
  req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  next();
}

// تطبيق CSRF على admin
app.use('/admin', csrfProtection);

// ─────────────────────────────────────────
// GLOBAL LOCALS FOR VIEWS
// ─────────────────────────────────────────
app.use((req, res, next) => {
  res.locals.admin     = req.session.admin   || null;
  res.locals.success   = req.session.success || null;
  res.locals.error     = req.session.error   || null;
  res.locals.csrfToken = generateCsrfToken(req);

  delete req.session.success;
  delete req.session.error;

  next();
});

// ─────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────
app.use('/admin', botRateLimit, adminRoutes);

// ─────────────────────────────────────────
// ROOT REDIRECT
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/admin/dashboard');
});

// ─────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─────────────────────────────────────────
// 404 HANDLER
// ─────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', {
    title:   '404 - الصفحة غير موجودة',
    message: 'الصفحة التي تبحث عنها غير موجودة.',
  });
});

// ─────────────────────────────────────────
// GLOBAL ERROR HANDLER
// ─────────────────────────────────────────
app.use((err, req, res, next) => {
  if (global.logger) global.logger.error('[APP ERROR] ' + err.message);
  console.error(err);

  res.status(500).render('error', {
    title:   'خطأ في الخادم',
    message: 'حدث خطأ داخلي. يرجى المحاولة لاحقاً.',
  });
});

module.exports = app;
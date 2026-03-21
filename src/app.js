const express        = require('express');
const session        = require('express-session');
const helmet         = require('helmet');
const methodOverride = require('method-override');
const path           = require('path');
const config         = require('../config/settings');
const { botRateLimit } = require('../middleware/rateLimit');
const adminRoutes    = require('../admin/routes/index');

const app = express();

// ─────────────────────────────────────────
// TRUST PROXY (مهم لـ Railway)
// ─────────────────────────────────────────
app.set('trust proxy', 1);

// ─────────────────────────────────────────
// SECURITY HEADERS
// ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc:     ["'self'", "data:", "https:"],
    },
  },
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
app.use('/public', express.static(path.join(__dirname, '../public')));

// ─────────────────────────────────────────
// SESSION - بدون PostgreSQL store
// نستخدم memory store بسيط لتجنب مشاكل pgSession
// ─────────────────────────────────────────
app.use(session({
  secret:            config.app.sessionSecret,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   false, // Railway يعالج HTTPS خارجياً
    httpOnly: true,
    maxAge:   config.security.sessionMaxAge,
    sameSite: 'lax', // lax بدلاً من strict لتجنب مشاكل redirect
  },
}));

// ─────────────────────────────────────────
// CSRF PROTECTION - مبسّط وموثوق
// ─────────────────────────────────────────
const csrf = require('csurf');

// نطبق CSRF على كل صفحات admin
const csrfProtection = csrf({
  cookie: false, // نخزن في session وليس cookie
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
});

app.use('/admin', csrfProtection);

// ─────────────────────────────────────────
// GLOBAL LOCALS FOR VIEWS
// ─────────────────────────────────────────
app.use((req, res, next) => {
  res.locals.admin     = req.session.admin  || null;
  res.locals.success   = req.session.success || null;
  res.locals.error     = req.session.error   || null;
  res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
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
// 404 HANDLER
// ─────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', {
    title:   '404 - Page Not Found',
    message: 'الصفحة غير موجودة',
  });
});

// ─────────────────────────────────────────
// GLOBAL ERROR HANDLER
// ─────────────────────────────────────────
app.use((err, req, res, next) => {
  // CSRF Error
  if (err.code === 'EBADCSRFTOKEN') {
    if (global.logger) global.logger.warn(`[CSRF] Invalid token from ${req.ip}`);
    // أعد توجيه لصفحة تسجيل الدخول بدلاً من عرض خطأ
    req.session.error = 'انتهت صلاحية الجلسة. يرجى تسجيل الدخول مجدداً.';
    return res.redirect('/admin/login');
  }

  if (global.logger) global.logger.error(`[APP ERROR] ${err.message}`);
  console.error(err);

  res.status(500).render('error', {
    title:   'خطأ في الخادم',
    message: 'حدث خطأ داخلي. يرجى المحاولة لاحقاً.',
  });
});

module.exports = app;
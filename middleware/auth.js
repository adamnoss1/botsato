// middleware/auth.js
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const config = require('../config/settings');

// ─────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (req.session && req.session.admin) {
    res.locals.admin = req.session.admin;
    return next();
  }
  req.session.returnTo = req.originalUrl;
  return res.redirect('/admin/login');
}

// ─────────────────────────────────────────
// SUPER ADMIN ONLY
// ─────────────────────────────────────────
function superAdminOnly(req, res, next) {
  if (req.session?.admin?.isSuperAdmin) return next();
  req.session.error = 'هذا الإجراء يتطلب صلاحيات المدير الأعلى';
  return res.redirect('/admin/dashboard');
}

// ─────────────────────────────────────────
// LOGIN HANDLER
// ─────────────────────────────────────────
async function handleLogin(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('login', {
      error:     'يرجى إدخال اسم المستخدم وكلمة المرور',
      csrfToken: res.locals.csrfToken || '',
    });
  }

  try {
    const admin = await prisma.admin.findUnique({ where: { username } });

    if (!admin || !admin.isActive) {
      return res.render('login', {
        error:     'بيانات الدخول غير صحيحة',
        csrfToken: res.locals.csrfToken || '',
      });
    }

    // فحص قفل الحساب
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((admin.lockedUntil - new Date()) / 60000);
      return res.render('login', {
        error:     `الحساب مقفل. يرجى الانتظار ${minutesLeft} دقيقة`,
        csrfToken: res.locals.csrfToken || '',
      });
    }

    // التحقق من كلمة المرور
    const isMatch = await bcrypt.compare(password, admin.passwordHash);

    if (!isMatch) {
      const newFailedCount = admin.failedLogins + 1;
      const updateData     = { failedLogins: newFailedCount };

      if (newFailedCount >= config.security.maxLoginAttempts) {
        updateData.lockedUntil  = new Date(
          Date.now() + config.security.lockDurationMinutes * 60 * 1000
        );
        updateData.failedLogins = 0;
      }

      await prisma.admin.update({ where: { id: admin.id }, data: updateData });

      const remaining = config.security.maxLoginAttempts - newFailedCount;
      const errorMsg  = remaining > 0
        ? `كلمة المرور غير صحيحة. تبقى ${remaining} محاولات`
        : `تم قفل الحساب لمدة ${config.security.lockDurationMinutes} دقيقة`;

      return res.render('login', {
        error:     errorMsg,
        csrfToken: res.locals.csrfToken || '',
      });
    }

    // ✅ تسجيل دخول ناجح
    await prisma.admin.update({
      where: { id: admin.id },
      data: {
        failedLogins: 0,
        lockedUntil:  null,
        lastLoginAt:  new Date(),
      },
    });

    // ✅ تجديد Session ID لمنع Session Fixation
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // ✅ توليد CSRF token جديد بعد regenerate
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');

    // حفظ بيانات الأدمن
    req.session.admin = {
      id:           admin.id,
      username:     admin.username,
      isSuperAdmin: admin.isSuperAdmin,
    };

    // حفظ الجلسة قبل الـ redirect
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // تسجيل في Audit Log
    await logAudit({
      adminId:   admin.id,
      action:    'LOGIN',
      ipAddress: req.ip,
      details:   { username: admin.username },
    });

    const returnTo = req.session.returnTo || '/admin/dashboard';
    delete req.session.returnTo;
    return res.redirect(returnTo);

  } catch (err) {
    if (global.logger) global.logger.error('[AUTH] Login error: ' + err.message);
    return res.render('login', {
      error:     'حدث خطأ. يرجى المحاولة لاحقاً',
      csrfToken: res.locals.csrfToken || '',
    });
  }
}

// ─────────────────────────────────────────
// LOGOUT HANDLER
// ─────────────────────────────────────────
async function handleLogout(req, res) {
  if (req.session.admin) {
    await logAudit({
      adminId:   req.session.admin.id,
      action:    'LOGOUT',
      ipAddress: req.ip,
    }).catch(() => {});
  }

  req.session.destroy((err) => {
    if (err && global.logger) {
      global.logger.error('[AUTH] Session destroy error: ' + err.message);
    }
    res.clearCookie('sid');
    res.redirect('/admin/login');
  });
}

// ─────────────────────────────────────────
// AUDIT LOG HELPER
// ─────────────────────────────────────────
async function logAudit({ adminId, action, targetType, targetId, details, ipAddress }) {
  try {
    await prisma.auditLog.create({
      data: {
        adminId:    adminId    || null,
        action,
        targetType: targetType || null,
        targetId:   targetId   || null,
        details:    details    || null,
        ipAddress:  ipAddress  || null,
      },
    });
  } catch (err) {
    if (global.logger) global.logger.error('[AUDIT] ' + err.message);
  }
}

module.exports = {
  authMiddleware,
  superAdminOnly,
  handleLogin,
  handleLogout,
  logAudit,
};
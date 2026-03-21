const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const config = require('../config/settings');

// ─────────────────────────────────────────
// CHECK IF ADMIN IS LOGGED IN
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
    return res.render('login', { error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
  }

  try {
    const admin = await prisma.admin.findUnique({ where: { username } });

    if (!admin || !admin.isActive) {
      return res.render('login', { error: 'بيانات الدخول غير صحيحة' });
    }

    // Check if account is locked
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((admin.lockedUntil - new Date()) / 60000);
      return res.render('login', {
        error: `الحساب مقفل. يرجى الانتظار ${minutesLeft} دقيقة`,
      });
    }

    const isMatch = await bcrypt.compare(password, admin.passwordHash);

    if (!isMatch) {
      const newFailedCount = admin.failedLogins + 1;
      const updateData = { failedLogins: newFailedCount };

      if (newFailedCount >= config.security.maxLoginAttempts) {
        updateData.lockedUntil = new Date(
          Date.now() + config.security.lockDurationMinutes * 60 * 1000
        );
        updateData.failedLogins = 0;
      }

      await prisma.admin.update({ where: { id: admin.id }, data: updateData });

      const remaining = config.security.maxLoginAttempts - newFailedCount;
      if (remaining > 0) {
        return res.render('login', { error: `كلمة المرور غير صحيحة. تبقى ${remaining} محاولات` });
      } else {
        return res.render('login', {
          error: `تم قفل الحساب لمدة ${config.security.lockDurationMinutes} دقيقة`,
        });
      }
    }

    // Successful login
    await prisma.admin.update({
      where: { id: admin.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    req.session.admin = {
      id:          admin.id,
      username:    admin.username,
      isSuperAdmin: admin.isSuperAdmin,
    };

    // Audit log
    await prisma.auditLog.create({
      data: {
        adminId:    admin.id,
        action:     'LOGIN',
        ipAddress:  req.ip,
        details:    { username: admin.username },
      },
    });

    const returnTo = req.session.returnTo || '/admin/dashboard';
    delete req.session.returnTo;
    return res.redirect(returnTo);

  } catch (err) {
    console.error('[AUTH ERROR]', err);
    return res.render('login', { error: 'حدث خطأ. يرجى المحاولة لاحقاً' });
  }
}

// ─────────────────────────────────────────
// LOGOUT HANDLER
// ─────────────────────────────────────────
async function handleLogout(req, res) {
  if (req.session.admin) {
    await prisma.auditLog.create({
      data: {
        adminId:   req.session.admin.id,
        action:    'LOGOUT',
        ipAddress: req.ip,
      },
    }).catch(() => {});
  }
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
}

// ─────────────────────────────────────────
// AUDIT LOG HELPER
// ─────────────────────────────────────────
async function logAudit({ adminId, action, targetType, targetId, details, ipAddress }) {
  try {
    await prisma.auditLog.create({
      data: { adminId, action, targetType, targetId, details, ipAddress },
    });
  } catch (err) {
    console.error('[AUDIT LOG ERROR]', err);
  }
}

module.exports = {
  authMiddleware,
  superAdminOnly,
  handleLogin,
  handleLogout,
  logAudit,
};
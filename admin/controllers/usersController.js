// admin/controllers/usersController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const userSvc   = require('../../services/userService');
const walletSvc = require('../../services/walletService');
const { logAudit } = require('../../middleware/auth');

async function index(req, res) {
  const page   = parseInt(req.query.page)   || 1;
  const search = req.query.search || '';
  const banned = req.query.banned === 'true' ? true : req.query.banned === 'false' ? false : null;

  const { users, total, pages } = await userSvc.listUsers({ page, limit: 30, search, banned });

  res.render('users', {
    title: 'المستخدمون',
    users, total, pages, page, search,
    banned: req.query.banned || '',
  });
}

async function show(req, res) {
  const userId = parseInt(req.params.id);
  if (isNaN(userId)) {
    req.session.error = 'معرف غير صالح';
    return res.redirect('/admin/users');
  }

  try {
    const user = await prisma.user.findUnique({
      where:   { id: userId },
      include: {
        orders:        { take: 5, orderBy: { createdAt: 'desc' }, include: { product: true } },
        deposits:      { take: 5, orderBy: { createdAt: 'desc' }, include: { method: true } },
        withdrawals:   { take: 5, orderBy: { createdAt: 'desc' }, include: { method: true } },
        // ⚠️ الإصلاح: الاسم الصحيح من schema.prisma هو referralGiven وليس referrals
        // وإزالة خيار "as" الذي لا يوجد في Prisma
        referralGiven: { take: 5, orderBy: { createdAt: 'desc' } },
        _count: { select: { orders: true, deposits: true, withdrawals: true } },
      },
    });

    if (!user) {
      req.session.error = 'المستخدم غير موجود';
      return res.redirect('/admin/users');
    }

    res.render('user-edit', { title: `مستخدم #${user.id}`, user });
  } catch (err) {
    console.error('[USERS:show]', err);
    req.session.error = 'حدث خطأ أثناء تحميل بيانات المستخدم';
    res.redirect('/admin/users');
  }
}

async function editForm(req, res) {
  const userId = parseInt(req.params.id);
  if (isNaN(userId)) {
    req.session.error = 'معرف غير صالح';
    return res.redirect('/admin/users');
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: { select: { orders: true, deposits: true, withdrawals: true } },
      },
    });

    if (!user) {
      req.session.error = 'المستخدم غير موجود';
      return res.redirect('/admin/users');
    }

    res.render('user-edit', { title: `تعديل مستخدم #${user.id}`, user });
  } catch (err) {
    console.error('[USERS:editForm]', err);
    req.session.error = 'حدث خطأ أثناء تحميل بيانات المستخدم';
    res.redirect('/admin/users');
  }
}

async function adjustBalance(req, res) {
  const { amount, description } = req.body;
  const userId = parseInt(req.params.id);

  if (isNaN(userId)) {
    req.session.error = 'معرف غير صالح';
    return res.redirect('/admin/users');
  }

  try {
    const amt = parseFloat(amount);
    if (isNaN(amt)) throw new Error('المبلغ غير صالح');

    await walletSvc.adminAdjustBalance(
      userId,
      amt,
      description || 'Admin adjustment'
    );

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'ADJUST_BALANCE',
      targetType: 'user',
      targetId:   userId,
      details:    { amount, description },
      ipAddress:  req.ip,
    });

    req.session.success = `تم تعديل الرصيد بمقدار ${amount}$`;
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect(`/admin/users/${userId}/edit`);
}

async function ban(req, res) {
  const userId = parseInt(req.params.id);
  const { reason } = req.body;

  if (isNaN(userId)) {
    req.session.error = 'معرف غير صالح';
    return res.redirect('/admin/users');
  }

  try {
    await userSvc.banUser(userId, reason);
    await logAudit({
      adminId:    req.session.admin.id,
      action:     'BAN_USER',
      targetType: 'user',
      targetId:   userId,
      details:    { reason },
      ipAddress:  req.ip,
    });
    req.session.success = 'تم حظر المستخدم';
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect(`/admin/users/${userId}/edit`);
}

async function unban(req, res) {
  const userId = parseInt(req.params.id);

  if (isNaN(userId)) {
    req.session.error = 'معرف غير صالح';
    return res.redirect('/admin/users');
  }

  try {
    await userSvc.unbanUser(userId);
    await logAudit({
      adminId:    req.session.admin.id,
      action:     'UNBAN_USER',
      targetType: 'user',
      targetId:   userId,
      ipAddress:  req.ip,
    });
    req.session.success = 'تم رفع الحظر عن المستخدم';
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect(`/admin/users/${userId}/edit`);
}

async function changeReferral(req, res) {
  const userId = parseInt(req.params.id);
  const { referralCode } = req.body;

  if (isNaN(userId)) {
    req.session.error = 'معرف غير صالح';
    return res.redirect('/admin/users');
  }

  try {
    if (!referralCode || !referralCode.trim()) throw new Error('رمز الإحالة مطلوب');

    const referrer = await prisma.user.findUnique({
      where: { referralCode: referralCode.toUpperCase().trim() },
    });

    if (!referrer) throw new Error('رمز الإحالة غير موجود');
    if (referrer.id === userId) throw new Error('لا يمكن تعيين المستخدم كمُحيل لنفسه');

    await prisma.user.update({
      where: { id: userId },
      data:  { referredById: referrer.id },
    });

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'CHANGE_REFERRAL',
      targetType: 'user',
      targetId:   userId,
      details:    { referralCode, referrerId: referrer.id },
      ipAddress:  req.ip,
    });

    req.session.success = 'تم تغيير المُحيل بنجاح';
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect(`/admin/users/${userId}/edit`);
}

module.exports = { index, show, editForm, adjustBalance, ban, unban, changeReferral };
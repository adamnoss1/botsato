const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const userSvc  = require('../../services/userService');
const walletSvc= require('../../services/walletService');
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
  const user = await prisma.user.findUnique({
    where:   { id: parseInt(req.params.id) },
    include: {
      orders:      { take: 5, orderBy: { createdAt: 'desc' } },
      deposits:    { take: 5, orderBy: { createdAt: 'desc' } },
      withdrawals: { take: 5, orderBy: { createdAt: 'desc' } },
      referrals:   { take: 5, orderBy: { createdAt: 'desc' }, as: 'referralGiven' },
      _count: { select: { orders: true, deposits: true, withdrawals: true } },
    },
  });

  if (!user) {
    req.session.error = 'المستخدم غير موجود';
    return res.redirect('/admin/users');
  }

  res.render('user-edit', { title: `مستخدم #${user.id}`, user });
}

async function editForm(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: parseInt(req.params.id) },
  });
  if (!user) {
    req.session.error = 'المستخدم غير موجود';
    return res.redirect('/admin/users');
  }
  res.render('user-edit', { title: `تعديل مستخدم #${user.id}`, user });
}

async function adjustBalance(req, res) {
  const { amount, description } = req.body;
  const userId = parseInt(req.params.id);

  try {
    await walletSvc.adminAdjustBalance(
      userId,
      parseFloat(amount),
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

  try {
    const referrer = await prisma.user.findUnique({
      where: { referralCode: referralCode.toUpperCase() },
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
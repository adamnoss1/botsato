const { PrismaClient } = require('@prisma/client');
const prisma  = new PrismaClient();
const bcrypt  = require('bcryptjs');
const { logAudit } = require('../../middleware/auth');

async function index(req, res) {
  const admins = await prisma.admin.findMany({ orderBy: { createdAt: 'asc' } });
  res.render('admins', { title: 'المديرون', admins });
}

async function create(req, res) {
  const { username, password, telegramId, isSuperAdmin } = req.body;

  try {
    if (!username || !password) throw new Error('اسم المستخدم وكلمة المرور مطلوبان');
    if (password.length < 8)    throw new Error('كلمة المرور يجب أن تكون 8 أحرف على الأقل');

    const hash = await bcrypt.hash(password, 12);
    const admin = await prisma.admin.create({
      data: {
        username,
        passwordHash: hash,
        telegramId:   telegramId ? BigInt(telegramId) : null,
        isSuperAdmin: isSuperAdmin === 'on',
        isActive:     true,
      },
    });

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'CREATE_ADMIN',
      targetType: 'admin',
      targetId:   admin.id,
      ipAddress:  req.ip,
    });

    req.session.success = `تم إنشاء المدير ${username}`;
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/admins');
}

async function toggle(req, res) {
  const id    = parseInt(req.params.id);
  const admin = await prisma.admin.findUnique({ where: { id } });
  if (!admin) { req.session.error = 'غير موجود'; return res.redirect('/admin/admins'); }
  if (admin.id === req.session.admin.id) {
    req.session.error = 'لا يمكنك تعطيل حسابك الخاص';
    return res.redirect('/admin/admins');
  }

  await prisma.admin.update({ where: { id }, data: { isActive: !admin.isActive } });
  req.session.success = `تم ${!admin.isActive ? 'تفعيل' : 'تعطيل'} المدير`;
  res.redirect('/admin/admins');
}

async function deleteAdmin(req, res) {
  const id = parseInt(req.params.id);
  if (id === req.session.admin.id) {
    req.session.error = 'لا يمكنك حذف حسابك الخاص';
    return res.redirect('/admin/admins');
  }
  try {
    await prisma.admin.delete({ where: { id } });
    req.session.success = 'تم حذف المدير';
  } catch (err) {
    req.session.error = err.message;
  }
  res.redirect('/admin/admins');
}

async function changePassword(req, res) {
  const id       = parseInt(req.params.id);
  const { password } = req.body;

  try {
    if (!password || password.length < 8) throw new Error('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
    const hash = await bcrypt.hash(password, 12);
    await prisma.admin.update({ where: { id }, data: { passwordHash: hash } });
    await logAudit({
      adminId: req.session.admin.id, action: 'CHANGE_ADMIN_PASSWORD',
      targetType: 'admin', targetId: id, ipAddress: req.ip,
    });
    req.session.success = 'تم تغيير كلمة المرور';
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/admins');
}

module.exports = { index, create, toggle, delete: deleteAdmin, changePassword };
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { logAudit } = require('../../middleware/auth');

// ── DEPOSIT METHODS ──────────────────────

async function depositIndex(req, res) {
  const methods = await prisma.depositMethod.findMany({ orderBy: { sortOrder: 'asc' } });
  res.render('deposit-methods', { title: 'طرق الإيداع', methods });
}

async function depositCreateForm(req, res) {
  res.render('deposit-method-form', { title: 'إضافة طريقة إيداع', method: null });
}

async function depositCreate(req, res) {
  const { name, nameAr, description, minAmount, maxAmount, exchangeRate, instructions } = req.body;
  try {
    const m = await prisma.depositMethod.create({
      data: {
        name, nameAr: nameAr || null,
        description:  description || null,
        minAmount:    parseFloat(minAmount),
        maxAmount:    parseFloat(maxAmount),
        exchangeRate: parseFloat(exchangeRate),
        instructions: instructions || null,
        isActive:     true,
      },
    });
    await logAudit({ adminId: req.session.admin.id, action: 'CREATE_DEPOSIT_METHOD', targetId: m.id, ipAddress: req.ip });
    req.session.success = 'تم إضافة طريقة الإيداع';
    res.redirect('/admin/deposit-methods');
  } catch (err) {
    req.session.error = err.message;
    res.redirect('/admin/deposit-methods/create');
  }
}

async function depositEditForm(req, res) {
  const method = await prisma.depositMethod.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!method) { req.session.error = 'غير موجود'; return res.redirect('/admin/deposit-methods'); }
  res.render('deposit-method-form', { title: `تعديل: ${method.name}`, method });
}

async function depositUpdate(req, res) {
  const id = parseInt(req.params.id);
  const { name, nameAr, description, minAmount, maxAmount, exchangeRate, instructions } = req.body;
  try {
    await prisma.depositMethod.update({
      where: { id },
      data: {
        name, nameAr: nameAr || null, description: description || null,
        minAmount: parseFloat(minAmount), maxAmount: parseFloat(maxAmount),
        exchangeRate: parseFloat(exchangeRate), instructions: instructions || null,
      },
    });
    req.session.success = 'تم تحديث طريقة الإيداع';
  } catch (err) { req.session.error = err.message; }
  res.redirect('/admin/deposit-methods');
}

async function depositToggle(req, res) {
  const id = parseInt(req.params.id);
  const m  = await prisma.depositMethod.findUnique({ where: { id } });
  await prisma.depositMethod.update({ where: { id }, data: { isActive: !m.isActive } });
  req.session.success = `تم ${!m.isActive ? 'تفعيل' : 'تعطيل'} الطريقة`;
  res.redirect('/admin/deposit-methods');
}

// ── WITHDRAW METHODS ─────────────────────

async function withdrawIndex(req, res) {
  const methods = await prisma.withdrawMethod.findMany({ orderBy: { sortOrder: 'asc' } });
  res.render('withdraw-methods', { title: 'طرق السحب', methods });
}

async function withdrawCreateForm(req, res) {
  res.render('withdraw-method-form', { title: 'إضافة طريقة سحب', method: null });
}

async function withdrawCreate(req, res) {
  const { name, nameAr, description, minAmount, maxAmount, feeType, feeValue } = req.body;
  try {
    const m = await prisma.withdrawMethod.create({
      data: {
        name, nameAr: nameAr || null, description: description || null,
        minAmount: parseFloat(minAmount), maxAmount: parseFloat(maxAmount),
        feeType: feeType || 'percentage', feeValue: parseFloat(feeValue),
        isActive: true,
      },
    });
    await logAudit({ adminId: req.session.admin.id, action: 'CREATE_WITHDRAW_METHOD', targetId: m.id, ipAddress: req.ip });
    req.session.success = 'تم إضافة طريقة السحب';
    res.redirect('/admin/withdraw-methods');
  } catch (err) {
    req.session.error = err.message;
    res.redirect('/admin/withdraw-methods/create');
  }
}

async function withdrawEditForm(req, res) {
  const method = await prisma.withdrawMethod.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!method) { req.session.error = 'غير موجود'; return res.redirect('/admin/withdraw-methods'); }
  res.render('withdraw-method-form', { title: `تعديل: ${method.name}`, method });
}

async function withdrawUpdate(req, res) {
  const id = parseInt(req.params.id);
  const { name, nameAr, description, minAmount, maxAmount, feeType, feeValue } = req.body;
  try {
    await prisma.withdrawMethod.update({
      where: { id },
      data: {
        name, nameAr: nameAr || null, description: description || null,
        minAmount: parseFloat(minAmount), maxAmount: parseFloat(maxAmount),
        feeType, feeValue: parseFloat(feeValue),
      },
    });
    req.session.success = 'تم تحديث طريقة السحب';
  } catch (err) { req.session.error = err.message; }
  res.redirect('/admin/withdraw-methods');
}

async function withdrawToggle(req, res) {
  const id = parseInt(req.params.id);
  const m  = await prisma.withdrawMethod.findUnique({ where: { id } });
  await prisma.withdrawMethod.update({ where: { id }, data: { isActive: !m.isActive } });
  req.session.success = `تم ${!m.isActive ? 'تفعيل' : 'تعطيل'} الطريقة`;
  res.redirect('/admin/withdraw-methods');
}

module.exports = {
  depositIndex, depositCreateForm, depositCreate, depositEditForm, depositUpdate, depositToggle,
  withdrawIndex, withdrawCreateForm, withdrawCreate, withdrawEditForm, withdrawUpdate, withdrawToggle,
};
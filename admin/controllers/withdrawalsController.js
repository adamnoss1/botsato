// admin/controllers/withdrawalsController.js
const withdrawSvc  = require('../../services/withdrawService');
const notifySvc    = require('../../services/notificationService');
const { logAudit } = require('../../middleware/auth');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function index(req, res) {
  const page   = parseInt(req.query.page) || 1;
  const status = req.query.status || null;

  const { withdrawals, total, pages } = await withdrawSvc.getWithdrawals({
    page, limit: 20, status,
  });

  res.render('withdrawals', {
    title: 'السحوبات',
    withdrawals, total, pages, page,
    currentStatus: status || '',
  });
}

async function approve(req, res) {
  const wId = parseInt(req.params.id);

  try {
    await withdrawSvc.approveWithdrawal(wId);

    // ✅ إرسال إشعار للمستخدم
    const withdrawal = await prisma.withdrawal.findUnique({
      where:   { id: wId },
      include: { user: true, method: true },
    });

    await notifySvc.notifyUserWithdrawalApproved(
      withdrawal?.user?.telegramId,
      withdrawal,
      withdrawal?.method
    ).catch(() => {});

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'APPROVE_WITHDRAWAL',
      targetType: 'withdrawal',
      targetId:   wId,
      ipAddress:  req.ip,
    });

    req.session.success = `تمت الموافقة على السحب #${wId}`;
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/withdrawals');
}

async function complete(req, res) {
  const wId = parseInt(req.params.id);

  try {
    await withdrawSvc.completeWithdrawal(wId);

    // ✅ إرسال إشعار إكمال للمستخدم
    const withdrawal = await prisma.withdrawal.findUnique({
      where:   { id: wId },
      include: { user: true, method: true },
    });

    await notifySvc.notifyUserWithdrawalCompleted(
      withdrawal?.user?.telegramId,
      withdrawal,
      withdrawal?.method
    ).catch(() => {});

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'COMPLETE_WITHDRAWAL',
      targetType: 'withdrawal',
      targetId:   wId,
      ipAddress:  req.ip,
    });

    req.session.success = `تم إكمال السحب #${wId}`;
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/withdrawals');
}

async function reject(req, res) {
  const wId  = parseInt(req.params.id);
  const note = req.body.note || '';

  try {
    // جلب بيانات السحب قبل الرفض لإرسال الإشعار
    const withdrawal = await prisma.withdrawal.findUnique({
      where:   { id: wId },
      include: { user: true, method: true },
    });

    await withdrawSvc.rejectWithdrawal(wId, note);

    // ✅ إرسال إشعار رفض للمستخدم مع معلومات الاسترداد
    await notifySvc.notifyUserWithdrawalRejected(
      withdrawal?.user?.telegramId,
      withdrawal,
      note
    ).catch(() => {});

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'REJECT_WITHDRAWAL',
      targetType: 'withdrawal',
      targetId:   wId,
      details:    { note },
      ipAddress:  req.ip,
    });

    req.session.success = `تم رفض السحب #${wId}`;
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/withdrawals');
}

module.exports = { index, approve, complete, reject };
const depositSvc = require('../../services/depositService');
const notifySvc  = require('../../services/notificationService');
const { logAudit } = require('../../middleware/auth');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function index(req, res) {
  const page   = parseInt(req.query.page) || 1;
  const status = req.query.status || null;

  const { deposits, total, pages } = await depositSvc.getDeposits({
    page, limit: 20, status,
  });

  res.render('deposits', {
    title: 'الإيداعات',
    deposits, total, pages, page,
    currentStatus: status || '',
  });
}

async function approve(req, res) {
  const depositId = parseInt(req.params.id);

  try {
    const deposit = await depositSvc.approveDeposit(depositId, req.session.admin.id);

    // Notify user
    const fullDeposit = await prisma.deposit.findUnique({
      where:   { id: depositId },
      include: { user: true },
    });
    await notifySvc.notifyUserDepositApproved(
      fullDeposit.user?.telegramId,
      fullDeposit.amountUsd
    ).catch(() => {});

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'APPROVE_DEPOSIT',
      targetType: 'deposit',
      targetId:   depositId,
      ipAddress:  req.ip,
    });

    req.session.success = `تمت الموافقة على الإيداع #${depositId}`;
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/deposits');
}

async function reject(req, res) {
  const depositId = parseInt(req.params.id);
  const { note }  = req.body;

  try {
    const deposit = await depositSvc.rejectDeposit(depositId, note);

    const fullDeposit = await prisma.deposit.findUnique({
      where:   { id: depositId },
      include: { user: true },
    });
    await notifySvc.notifyUserDepositRejected(
      fullDeposit.user?.telegramId,
      note
    ).catch(() => {});

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'REJECT_DEPOSIT',
      targetType: 'deposit',
      targetId:   depositId,
      details:    { note },
      ipAddress:  req.ip,
    });

    req.session.success = `تم رفض الإيداع #${depositId}`;
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/deposits');
}

module.exports = { index, approve, reject };
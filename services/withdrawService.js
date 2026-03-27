// services/withdrawService.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─────────────────────────────────────────
// GET ACTIVE WITHDRAW METHODS
// ─────────────────────────────────────────
async function getActiveMethods() {
  return prisma.withdrawMethod.findMany({
    where:   { isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
}

// ─────────────────────────────────────────
// CALCULATE FEE
// يحسب الرسوم والصافي بالدولار
// ─────────────────────────────────────────
function calculateFee(method, amountUsd) {
  const amt = parseFloat(amountUsd);
  let fee   = 0;

  if (method.feeType === 'percentage') {
    fee = amt * parseFloat(method.feeValue);
  } else {
    // ثابت بالدولار
    fee = parseFloat(method.feeValue);
  }

  fee = parseFloat(fee.toFixed(4));
  const netAmount = parseFloat((amt - fee).toFixed(4));

  return { fee, netAmount };
}

// ─────────────────────────────────────────
// CALCULATE LOCAL AMOUNT
// تحويل من دولار إلى العملة المحلية
// ─────────────────────────────────────────
function calculateLocalAmount(amountUsd, exchangeRate) {
  const rate  = parseFloat(exchangeRate) || 1;
  const local = parseFloat((parseFloat(amountUsd) * rate).toFixed(4));
  return local;
}

// ─────────────────────────────────────────
// CREATE WITHDRAWAL REQUEST
// ─────────────────────────────────────────
async function createWithdrawal(userId, methodId, amountUsd, accountInfo) {
  const method = await prisma.withdrawMethod.findUnique({
    where: { id: parseInt(methodId) },
  });
  if (!method || !method.isActive) throw new Error('طريقة السحب غير متاحة');

  const amt          = parseFloat(amountUsd);
  const minAmountUsd = parseFloat(method.minAmount);
  const maxAmountUsd = parseFloat(method.maxAmount);

  if (amt < minAmountUsd) {
    throw new Error(`الحد الأدنى للسحب ${minAmountUsd}$`);
  }
  if (amt > maxAmountUsd) {
    throw new Error(`الحد الأقصى للسحب ${maxAmountUsd}$`);
  }

  const { fee, netAmount } = calculateFee(method, amt);
  if (netAmount <= 0) throw new Error('المبلغ بعد الرسوم أقل من الصفر');

  // حساب المبلغ المحلي
  const exchangeRate  = parseFloat(method.exchangeRate) || 1;
  const netAmountLocal = calculateLocalAmount(netAmount, exchangeRate);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: parseInt(userId) } });
    if (!user) throw new Error('المستخدم غير موجود');

    const balance = parseFloat(user.balance);
    if (balance < amt) throw new Error('رصيد غير كافٍ');

    const balanceBefore = balance;
    const balanceAfter  = parseFloat((balance - amt).toFixed(4));

    await tx.user.update({
      where: { id: user.id },
      data:  { balance: balanceAfter },
    });

    const withdrawal = await tx.withdrawal.create({
      data: {
        userId:         user.id,
        methodId:       parseInt(methodId),
        amount:         amt,
        fee,
        netAmount,
        // حفظ المبلغ المحلي في accountInfo
        accountInfo:    accountInfo,
        status:         'PENDING',
      },
    });

    await tx.walletTransaction.create({
      data: {
        userId:        user.id,
        type:          'WITHDRAW',
        amount:        amt,
        balanceBefore,
        balanceAfter,
        description:   `سحب عبر ${method.name}`,
        refId:         String(withdrawal.id),
      },
    });

    return { ...withdrawal, netAmountLocal, exchangeRate };
  });
}

// ─────────────────────────────────────────
// APPROVE WITHDRAWAL
// ─────────────────────────────────────────
async function approveWithdrawal(withdrawalId) {
  const w = await prisma.withdrawal.findUnique({
    where: { id: parseInt(withdrawalId) },
  });
  if (!w) throw new Error('السحب غير موجود');
  if (w.status !== 'PENDING') throw new Error('تم معالجة هذا السحب مسبقاً');

  return prisma.withdrawal.update({
    where: { id: parseInt(withdrawalId) },
    data:  { status: 'APPROVED', approvedAt: new Date() },
  });
}

// ─────────────────────────────────────────
// COMPLETE WITHDRAWAL
// ─────────────────────────────────────────
async function completeWithdrawal(withdrawalId) {
  return prisma.withdrawal.update({
    where: { id: parseInt(withdrawalId) },
    data:  { status: 'COMPLETED', completedAt: new Date() },
  });
}

// ─────────────────────────────────────────
// REJECT WITHDRAWAL — استرداد الرصيد
// ─────────────────────────────────────────
async function rejectWithdrawal(withdrawalId, adminNote = '') {
  return prisma.$transaction(async (tx) => {
    const w = await tx.withdrawal.findUnique({
      where: { id: parseInt(withdrawalId) },
    });
    if (!w) throw new Error('السحب غير موجود');
    if (!['PENDING', 'APPROVED'].includes(w.status)) {
      throw new Error('لا يمكن رفض هذا السحب');
    }

    const user   = await tx.user.findUnique({ where: { id: w.userId } });
    const before = parseFloat(user.balance);
    const after  = parseFloat((before + parseFloat(w.amount)).toFixed(4));

    await tx.user.update({
      where: { id: w.userId },
      data:  { balance: after },
    });

    await tx.walletTransaction.create({
      data: {
        userId:        w.userId,
        type:          'REFUND',
        amount:        parseFloat(w.amount),
        balanceBefore: before,
        balanceAfter:  after,
        description:   'استرداد سحب مرفوض',
        refId:         String(w.id),
      },
    });

    return tx.withdrawal.update({
      where: { id: w.id },
      data:  { status: 'REJECTED', adminNote, rejectedAt: new Date() },
    });
  });
}

// ─────────────────────────────────────────
// GET WITHDRAWALS (paginated)
// ─────────────────────────────────────────
async function getWithdrawals({ page = 1, limit = 20, status = null, userId = null } = {}) {
  const skip  = (page - 1) * limit;
  const where = {};
  if (status) where.status = status;
  if (userId) where.userId = parseInt(userId);

  const [withdrawals, total] = await Promise.all([
    prisma.withdrawal.findMany({
      where,
      skip,
      take:    limit,
      orderBy: { createdAt: 'desc' },
      include: { user: true, method: true },
    }),
    prisma.withdrawal.count({ where }),
  ]);

  return { withdrawals, total, pages: Math.ceil(total / limit), page };
}

module.exports = {
  getActiveMethods,
  calculateFee,
  calculateLocalAmount,
  createWithdrawal,
  approveWithdrawal,
  completeWithdrawal,
  rejectWithdrawal,
  getWithdrawals,
};
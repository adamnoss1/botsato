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
// ─────────────────────────────────────────
function calculateFee(method, amount) {
  const amt = parseFloat(amount);
  let fee   = 0;

  if (method.feeType === 'percentage') {
    fee = amt * parseFloat(method.feeValue);
  } else {
    fee = parseFloat(method.feeValue);
  }

  return {
    fee:       parseFloat(fee.toFixed(4)),
    netAmount: parseFloat((amt - fee).toFixed(4)),
  };
}

// ─────────────────────────────────────────
// CREATE WITHDRAWAL REQUEST
// ─────────────────────────────────────────
async function createWithdrawal(userId, methodId, amount, accountInfo) {
  const method = await prisma.withdrawMethod.findUnique({
    where: { id: parseInt(methodId) },
  });
  if (!method || !method.isActive) throw new Error('طريقة السحب غير متاحة');

  const amt = parseFloat(amount);
  if (amt < parseFloat(method.minAmount)) throw new Error(`الحد الأدنى للسحب ${method.minAmount}$`);
  if (amt > parseFloat(method.maxAmount)) throw new Error(`الحد الأقصى للسحب ${method.maxAmount}$`);

  const { fee, netAmount } = calculateFee(method, amt);
  if (netAmount <= 0) throw new Error('المبلغ بعد الرسوم أقل من الصفر');

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: parseInt(userId) } });
    if (!user) throw new Error('المستخدم غير موجود');

    const balance = parseFloat(user.balance);
    if (balance < amt) throw new Error('رصيد غير كافٍ');

    // Deduct immediately
    const balanceBefore = balance;
    const balanceAfter  = balance - amt;

    await tx.user.update({
      where: { id: user.id },
      data:  { balance: balanceAfter },
    });

    const withdrawal = await tx.withdrawal.create({
      data: {
        userId:     user.id,
        methodId:   parseInt(methodId),
        amount:     amt,
        fee,
        netAmount,
        accountInfo,
        status:     'PENDING',
      },
    });

    await tx.walletTransaction.create({
      data: {
        userId,
        type:          'WITHDRAW',
        amount:        amt,
        balanceBefore,
        balanceAfter,
        description:   `سحب عبر ${method.name}`,
        refId:         String(withdrawal.id),
      },
    });

    return withdrawal;
  });
}

// ─────────────────────────────────────────
// APPROVE WITHDRAWAL
// ─────────────────────────────────────────
async function approveWithdrawal(withdrawalId) {
  const w = await prisma.withdrawal.findUnique({ where: { id: parseInt(withdrawalId) } });
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
// REJECT WITHDRAWAL (refund balance)
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

    // Refund balance
    const user   = await tx.user.findUnique({ where: { id: w.userId } });
    const before = parseFloat(user.balance);
    const after  = before + parseFloat(w.amount);

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
      take: limit,
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
  createWithdrawal,
  approveWithdrawal,
  completeWithdrawal,
  rejectWithdrawal,
  getWithdrawals,
};
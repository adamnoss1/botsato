const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─────────────────────────────────────────
// GET ACTIVE DEPOSIT METHODS
// ─────────────────────────────────────────
async function getActiveMethods() {
  return prisma.depositMethod.findMany({
    where:   { isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
}

// ─────────────────────────────────────────
// CREATE DEPOSIT REQUEST
// ─────────────────────────────────────────
async function createDeposit(userId, methodId, amountLocal, transactionId) {
  const method = await prisma.depositMethod.findUnique({
    where: { id: parseInt(methodId) },
  });
  if (!method || !method.isActive) throw new Error('طريقة الإيداع غير متاحة');

  const amt = parseFloat(amountLocal);
  if (amt < parseFloat(method.minAmount)) throw new Error(`الحد الأدنى للإيداع ${method.minAmount}`);
  if (amt > parseFloat(method.maxAmount)) throw new Error(`الحد الأقصى للإيداع ${method.maxAmount}`);

  // Check duplicate transaction ID for this method
  const duplicate = await prisma.deposit.findUnique({
    where: {
      transactionId_methodId: {
        transactionId,
        methodId: parseInt(methodId),
      },
    },
  });
  if (duplicate) throw new Error('رقم المعاملة مستخدم مسبقاً');

  const rate      = parseFloat(method.exchangeRate);
  const amountUsd = parseFloat((amt / rate).toFixed(4));

  const deposit = await prisma.deposit.create({
    data: {
      userId:        parseInt(userId),
      methodId:      parseInt(methodId),
      amountLocal:   amt,
      amountUsd,
      exchangeRate:  rate,
      transactionId,
      status:        'PENDING',
    },
    include: { method: true, user: true },
  });

  // Notify admins (lazy require لتجنب circular dependencies)
  try {
    const { notifyAdminsDeposit } = require('./notificationService');
    await notifyAdminsDeposit(deposit);
  } catch (_) {}

  return deposit;
}

// ─────────────────────────────────────────
// APPROVE DEPOSIT
// ─────────────────────────────────────────
async function approveDeposit(depositId, adminId) {
  return prisma.$transaction(async (tx) => {
    const deposit = await tx.deposit.findUnique({
      where:   { id: parseInt(depositId) },
      include: { user: true, method: true },
    });

    if (!deposit)                      throw new Error('الإيداع غير موجود');
    if (deposit.status !== 'PENDING')  throw new Error('تم معالجة هذا الإيداع مسبقاً');

    await tx.deposit.update({
      where: { id: deposit.id },
      data:  { status: 'APPROVED', approvedAt: new Date() },
    });

    const user   = await tx.user.findUnique({ where: { id: deposit.userId } });
    const before = parseFloat(user.balance);
    const after  = before + parseFloat(deposit.amountUsd);

    await tx.user.update({
      where: { id: deposit.userId },
      data: {
        balance:        after,
        totalDeposited: { increment: parseFloat(deposit.amountUsd) },
      },
    });

    await tx.walletTransaction.create({
      data: {
        userId:        deposit.userId,
        type:          'DEPOSIT',
        amount:        parseFloat(deposit.amountUsd),
        balanceBefore: before,
        balanceAfter:  after,
        description:   `إيداع عبر ${deposit.method?.name || 'غير محدد'}`,
        refId:         String(deposit.id),
      },
    });

    return deposit;

  }).then(async (deposit) => {
    // Update VIP level after deposit (lazy require)
    try {
      const { updateVipLevel } = require('./vipService');
      await updateVipLevel(deposit.userId);
    } catch (_) {}
    return deposit;
  });
}

// ─────────────────────────────────────────
// REJECT DEPOSIT
// ─────────────────────────────────────────
async function rejectDeposit(depositId, adminNote = '') {
  const deposit = await prisma.deposit.findUnique({
    where: { id: parseInt(depositId) },
  });
  if (!deposit)                     throw new Error('الإيداع غير موجود');
  if (deposit.status !== 'PENDING') throw new Error('تم معالجة هذا الإيداع مسبقاً');

  return prisma.deposit.update({
    where: { id: parseInt(depositId) },
    data:  { status: 'REJECTED', adminNote, rejectedAt: new Date() },
  });
}

// ─────────────────────────────────────────
// GET DEPOSITS (paginated)
// ─────────────────────────────────────────
async function getDeposits({ page = 1, limit = 20, status = null, userId = null } = {}) {
  const skip  = (page - 1) * limit;
  const where = {};
  if (status) where.status = status;
  if (userId) where.userId = parseInt(userId);

  const [deposits, total] = await Promise.all([
    prisma.deposit.findMany({
      where,
      skip,
      take:    limit,
      orderBy: { createdAt: 'desc' },
      include: { user: true, method: true },
    }),
    prisma.deposit.count({ where }),
  ]);

  return { deposits, total, pages: Math.ceil(total / limit), page };
}

// ─────────────────────────────────────────
// GET PENDING COUNT
// ─────────────────────────────────────────
async function getPendingCount() {
  return prisma.deposit.count({ where: { status: 'PENDING' } });
}

module.exports = {
  getActiveMethods,
  createDeposit,
  approveDeposit,
  rejectDeposit,
  getDeposits,
  getPendingCount,
};
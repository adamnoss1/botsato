const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─────────────────────────────────────────
// CREDIT BALANCE (atomic)
// ─────────────────────────────────────────
async function creditBalance(userId, amount, type, description = '', refId = null) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    const balanceBefore = parseFloat(user.balance);
    const balanceAfter  = balanceBefore + parseFloat(amount);

    await tx.user.update({
      where: { id: userId },
      data:  { balance: balanceAfter },
    });

    const txRecord = await tx.walletTransaction.create({
      data: {
        userId,
        type,
        amount:        parseFloat(amount),
        balanceBefore,
        balanceAfter,
        description,
        refId,
      },
    });

    return { balanceBefore, balanceAfter, transaction: txRecord };
  });
}

// ─────────────────────────────────────────
// DEBIT BALANCE (atomic)
// ─────────────────────────────────────────
async function debitBalance(userId, amount, type, description = '', refId = null) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    const balanceBefore = parseFloat(user.balance);
    if (balanceBefore < parseFloat(amount)) {
      throw new Error('Insufficient balance');
    }

    const balanceAfter = balanceBefore - parseFloat(amount);

    await tx.user.update({
      where: { id: userId },
      data:  { balance: balanceAfter },
    });

    const txRecord = await tx.walletTransaction.create({
      data: {
        userId,
        type,
        amount:        parseFloat(amount),
        balanceBefore,
        balanceAfter,
        description,
        refId,
      },
    });

    return { balanceBefore, balanceAfter, transaction: txRecord };
  });
}

// ─────────────────────────────────────────
// TRANSFER BETWEEN USERS
// ─────────────────────────────────────────
async function transferBalance(fromUserId, toUserId, amount, description = '') {
  if (fromUserId === toUserId) throw new Error('Cannot transfer to yourself');

  return prisma.$transaction(async (tx) => {
    const fromUser = await tx.user.findUnique({ where: { id: fromUserId } });
    const toUser   = await tx.user.findUnique({ where: { id: toUserId } });

    if (!fromUser) throw new Error('Sender not found');
    if (!toUser)   throw new Error('Receiver not found');
    if (toUser.isBanned) throw new Error('Receiver account is banned');

    const amt = parseFloat(amount);
    const fromBalance = parseFloat(fromUser.balance);

    if (fromBalance < amt) throw new Error('Insufficient balance');

    const fromBefore = fromBalance;
    const fromAfter  = fromBalance - amt;
    const toBefore   = parseFloat(toUser.balance);
    const toAfter    = toBefore + amt;

    await tx.user.update({ where: { id: fromUserId }, data: { balance: fromAfter } });
    await tx.user.update({ where: { id: toUserId },   data: { balance: toAfter } });

    await tx.walletTransaction.create({
      data: {
        userId:        fromUserId,
        type:          'TRANSFER_OUT',
        amount:        amt,
        balanceBefore: fromBefore,
        balanceAfter:  fromAfter,
        description:   `تحويل إلى ${toUser.firstName}`,
        transferToId:  toUserId,
      },
    });

    await tx.walletTransaction.create({
      data: {
        userId:        toUserId,
        type:          'TRANSFER_IN',
        amount:        amt,
        balanceBefore: toBefore,
        balanceAfter:  toAfter,
        description:   `تحويل من ${fromUser.firstName}`,
      },
    });

    return { fromAfter, toAfter };
  });
}

// ─────────────────────────────────────────
// GET TRANSACTION HISTORY (paginated)
// ─────────────────────────────────────────
async function getTransactions(userId, { page = 1, limit = 10, type = null } = {}) {
  const skip  = (page - 1) * limit;
  const where = { userId };
  if (type) where.type = type;

  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  return { transactions, total, pages: Math.ceil(total / limit), page };
}

// ─────────────────────────────────────────
// ADMIN ADJUST BALANCE
// ─────────────────────────────────────────
async function adminAdjustBalance(userId, amount, description = 'Admin adjustment') {
  const amt = parseFloat(amount);
  if (amt > 0) {
    return creditBalance(userId, amt, 'ADJUSTMENT', description);
  } else {
    return debitBalance(userId, Math.abs(amt), 'ADJUSTMENT', description);
  }
}

module.exports = {
  creditBalance,
  debitBalance,
  transferBalance,
  getTransactions,
  adminAdjustBalance,
};
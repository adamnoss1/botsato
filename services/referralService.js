const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─────────────────────────────────────────
// CREDIT REFERRAL COMMISSION
// ─────────────────────────────────────────
async function creditReferral(userId, orderId, orderTotal) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { referredBy: true },
  });

  if (!user?.referredBy) return null;

  const { getSetting } = require('./settingsService');
  const commissionRate = parseFloat(await getSetting('referral_commission') || '0.05');
  const commission     = parseFloat((parseFloat(orderTotal) * commissionRate).toFixed(4));

  if (commission <= 0) return null;

  await prisma.$transaction(async (tx) => {
    const referrer = await tx.user.findUnique({ where: { id: user.referredById } });
    const before   = parseFloat(referrer.balance);
    const after    = before + commission;

    await tx.user.update({
      where: { id: referrer.id },
      data:  { balance: after },
    });

    await tx.walletTransaction.create({
      data: {
        userId:        referrer.id,
        type:          'COMMISSION',
        amount:        commission,
        balanceBefore: before,
        balanceAfter:  after,
        description:   `عمولة إحالة - طلب #${orderId}`,
        refId:         String(orderId),
      },
    });

    await tx.referral.create({
      data: {
        fromUserId: referrer.id,
        toUserId:   userId,
        orderId:    parseInt(orderId),
        commission,
      },
    });
  });

  return commission;
}

// ─────────────────────────────────────────
// GET REFERRAL STATS FOR USER
// ─────────────────────────────────────────
async function getReferralStats(userId) {
  const [invitedCount, commissions] = await Promise.all([
    prisma.user.count({ where: { referredById: parseInt(userId) } }),
    prisma.referral.aggregate({
      where:  { fromUserId: parseInt(userId) },
      _sum:   { commission: true },
      _count: { id: true },
    }),
  ]);

  return {
    invitedCount,
    totalCommission: parseFloat(commissions._sum.commission || 0),
    totalOrders:     commissions._count.id,
  };
}

// ─────────────────────────────────────────
// GET REFERRAL LIST FOR USER
// ─────────────────────────────────────────
async function getReferralList(userId, { page = 1, limit = 10 } = {}) {
  const skip = (page - 1) * limit;

  const [referrals, total] = await Promise.all([
    prisma.referral.findMany({
      where:   { fromUserId: parseInt(userId) },
      skip,
      take:    limit,
      orderBy: { createdAt: 'desc' },
      include: { toUser: { select: { firstName: true, username: true } } },
    }),
    prisma.referral.count({ where: { fromUserId: parseInt(userId) } }),
  ]);

  return { referrals, total, pages: Math.ceil(total / limit) };
}

module.exports = { creditReferral, getReferralStats, getReferralList };
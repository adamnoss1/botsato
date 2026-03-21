const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function index(req, res) {
  try {
    const [
      totalUsers,
      totalOrders,
      pendingDeposits,
      pendingManualOrders,
      processingOrders,
      revenueResult,
      latestOrders,
      latestDeposits,
      todayUsers,
      todayOrders,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.order.count(),
      prisma.deposit.count({ where: { status: 'PENDING' } }),
      prisma.manualOrder.count({ where: { status: 'PENDING' } }),
      prisma.order.count({ where: { status: 'PROCESSING' } }),
      prisma.walletTransaction.aggregate({
        where: { type: 'ORDER' },
        _sum:  { amount: true },
      }),
      prisma.order.findMany({
        take:    10,
        orderBy: { createdAt: 'desc' },
        include: { user: true, product: true },
      }),
      prisma.deposit.findMany({
        take:    10,
        orderBy: { createdAt: 'desc' },
        include: { user: true, method: true },
      }),
      prisma.user.count({
        where: {
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
      prisma.order.count({
        where: {
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
    ]);

    const totalRevenue = parseFloat(revenueResult._sum.amount || 0).toFixed(2);

    res.render('dashboard', {
      title: 'لوحة التحكم',
      totalUsers,
      totalOrders,
      pendingDeposits,
      pendingManualOrders,
      processingOrders,
      totalRevenue,
      latestOrders,
      latestDeposits,
      todayUsers,
      todayOrders,
    });
  } catch (err) {
    console.error('[DASHBOARD]', err);
    res.render('error', { title: 'خطأ', message: err.message });
  }
}

module.exports = { index };
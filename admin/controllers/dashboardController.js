// admin/controllers/dashboardController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function index(req, res) {
  try {
    const now              = new Date();
    const startOfToday     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth     = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [
      // ── إحصائيات عامة ──
      totalUsers,
      totalOrders,
      pendingDeposits,
      pendingManualOrders,
      processingOrders,

      // ── إحصائيات اليوم ──
      todayUsers,
      todayOrders,

      // ── الإيرادات الكاملة (جميع الطلبات) ──
      allOrdersRevenue,

      // ── الإيرادات المكتملة فقط ──
      completedOrdersRevenue,

      // ── إيرادات اليوم ──
      todayRevenue,

      // ── إيرادات الشهر الحالي ──
      monthRevenue,

      // ── إيرادات الشهر الماضي (للمقارنة) ──
      lastMonthRevenue,

      // ── الإيداعات المقبولة ──
      totalDeposits,
      todayDeposits,
      monthDeposits,

      // ── السحوبات المكتملة ──
      totalWithdrawals,
      monthWithdrawals,

      // ── العمولات المدفوعة ──
      totalCommissions,
      monthCommissions,

      // ── أحدث الطلبات ──
      latestOrders,

      // ── أحدث الإيداعات ──
      latestDeposits,

      // ── أفضل المنتجات مبيعاً ──
      topProducts,

    ] = await Promise.all([

      // إحصائيات عامة
      prisma.user.count(),
      prisma.order.count(),
      prisma.deposit.count({ where: { status: 'PENDING' } }),
      prisma.manualOrder.count({ where: { status: 'PENDING' } }),
      prisma.order.count({ where: { status: 'PROCESSING' } }),

      // اليوم
      prisma.user.count({ where: { createdAt: { gte: startOfToday } } }),
      prisma.order.count({ where: { createdAt: { gte: startOfToday } } }),

      // إجمالي إيرادات جميع الطلبات
      prisma.order.aggregate({
        _sum: { totalPrice: true },
      }),

      // إيرادات الطلبات المكتملة فقط
      prisma.order.aggregate({
        where: { status: 'COMPLETED' },
        _sum:  { totalPrice: true },
      }),

      // إيرادات اليوم
      prisma.order.aggregate({
        where: { createdAt: { gte: startOfToday } },
        _sum:  { totalPrice: true },
      }),

      // إيرادات الشهر الحالي
      prisma.order.aggregate({
        where: { createdAt: { gte: startOfMonth } },
        _sum:  { totalPrice: true },
      }),

      // إيرادات الشهر الماضي
      prisma.order.aggregate({
        where: { createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } },
        _sum:  { totalPrice: true },
      }),

      // إجمالي الإيداعات المقبولة
      prisma.deposit.aggregate({
        where: { status: 'APPROVED' },
        _sum:  { amountUsd: true },
        _count: { id: true },
      }),

      // إيداعات اليوم
      prisma.deposit.aggregate({
        where: { status: 'APPROVED', approvedAt: { gte: startOfToday } },
        _sum:  { amountUsd: true },
        _count: { id: true },
      }),

      // إيداعات الشهر
      prisma.deposit.aggregate({
        where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } },
        _sum:  { amountUsd: true },
        _count: { id: true },
      }),

      // إجمالي السحوبات المكتملة
      prisma.withdrawal.aggregate({
        where: { status: 'COMPLETED' },
        _sum:  { netAmount: true },
        _count: { id: true },
      }),

      // سحوبات الشهر
      prisma.withdrawal.aggregate({
        where: { status: 'COMPLETED', completedAt: { gte: startOfMonth } },
        _sum:  { netAmount: true },
        _count: { id: true },
      }),

      // إجمالي العمولات
      prisma.referral.aggregate({
        _sum: { commission: true },
        _count: { id: true },
      }),

      // عمولات الشهر
      prisma.referral.aggregate({
        where: { createdAt: { gte: startOfMonth } },
        _sum:  { commission: true },
      }),

      // أحدث الطلبات
      prisma.order.findMany({
        take:    10,
        orderBy: { createdAt: 'desc' },
        include: { user: true, product: true },
      }),

      // أحدث الإيداعات
      prisma.deposit.findMany({
        take:    10,
        orderBy: { createdAt: 'desc' },
        include: { user: true, method: true },
      }),

      // أفضل المنتجات
      prisma.order.groupBy({
        by:      ['productId'],
        _count:  { id: true },
        _sum:    { totalPrice: true },
        orderBy: { _sum: { totalPrice: 'desc' } },
        take:    5,
      }),
    ]);

    // ─────────────────────────────────────────
    // حساب الأرباح
    // الربح = إجمالي ما دفعه المستخدمون - تكلفة Satofill
    // تكلفة Satofill ≈ إيرادات / (1 + margin)
    // ─────────────────────────────────────────
    const settings = await prisma.setting.findMany({
      where: { key: { in: ['profit_margin', 'exchange_rate'] } },
    });
    const settingsMap    = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    const profitMargin   = parseFloat(settingsMap.profit_margin || '0.20');
    const exchangeRate   = parseFloat(settingsMap.exchange_rate || '3.75');

    // الإيرادات الإجمالية بالعملة المحلية
    const totalRevenueLocal   = parseFloat(allOrdersRevenue._sum.totalPrice        || 0);
    const completedRevLocal   = parseFloat(completedOrdersRevenue._sum.totalPrice  || 0);
    const todayRevenueLocal   = parseFloat(todayRevenue._sum.totalPrice            || 0);
    const monthRevenueLocal   = parseFloat(monthRevenue._sum.totalPrice            || 0);
    const lastMonthRevLocal   = parseFloat(lastMonthRevenue._sum.totalPrice        || 0);

    // تحويل للدولار
    const totalRevenueUsd  = totalRevenueLocal  / exchangeRate;
    const completedRevUsd  = completedRevLocal  / exchangeRate;
    const todayRevenueUsd  = todayRevenueLocal  / exchangeRate;
    const monthRevenueUsd  = monthRevenueLocal  / exchangeRate;
    const lastMonthRevUsd  = lastMonthRevLocal  / exchangeRate;

    // الأرباح = الإيرادات × (margin / (1 + margin))
    // مثال: margin=20%, revenue=120 → profit=20 (لأن 100 تكلفة + 20 ربح)
    const profitRatio      = profitMargin / (1 + profitMargin);
    const totalProfitUsd   = totalRevenueUsd  * profitRatio;
    const completedProfUsd = completedRevUsd  * profitRatio;
    const todayProfitUsd   = todayRevenueUsd  * profitRatio;
    const monthProfitUsd   = monthRevenueUsd  * profitRatio;
    const lastMonthProfUsd = lastMonthRevUsd  * profitRatio;

    // نسبة التغيير عن الشهر الماضي
    const monthGrowth = lastMonthRevUsd > 0
      ? (((monthRevenueUsd - lastMonthRevUsd) / lastMonthRevUsd) * 100).toFixed(1)
      : null;

    // إجمالي الإيداعات
    const totalDepositsUsd  = parseFloat(totalDeposits._sum.amountUsd  || 0);
    const todayDepositsUsd  = parseFloat(todayDeposits._sum.amountUsd  || 0);
    const monthDepositsUsd  = parseFloat(monthDeposits._sum.amountUsd  || 0);

    // إجمالي السحوبات
    const totalWithdrawUsd  = parseFloat(totalWithdrawals._sum.netAmount || 0);
    const monthWithdrawUsd  = parseFloat(monthWithdrawals._sum.netAmount || 0);

    // العمولات
    const totalCommUsd      = parseFloat(totalCommissions._sum.commission || 0);
    const monthCommUsd      = parseFloat(monthCommissions._sum.commission  || 0);

    // صافي الرصيد في النظام = الإيداعات - السحوبات - العمولات
    const netBalanceUsd     = totalDepositsUsd - totalWithdrawUsd - totalCommUsd;

    // أفضل المنتجات — جلب تفاصيلها
    const topProductIds = topProducts.map(t => t.productId);
    const topProductDetails = await prisma.product.findMany({
      where:   { id: { in: topProductIds } },
      select:  { id: true, name: true },
    });
    const topProductsWithDetails = topProducts.map(t => ({
      ...t,
      product: topProductDetails.find(p => p.id === t.productId),
    }));

    res.render('dashboard', {
      title: 'لوحة التحكم',

      // إحصائيات عامة
      totalUsers,
      totalOrders,
      pendingDeposits,
      pendingManualOrders,
      processingOrders,
      todayUsers,
      todayOrders,

      // الإيرادات
      totalRevenueUsd:   totalRevenueUsd.toFixed(2),
      completedRevUsd:   completedRevUsd.toFixed(2),
      todayRevenueUsd:   todayRevenueUsd.toFixed(2),
      monthRevenueUsd:   monthRevenueUsd.toFixed(2),
      lastMonthRevUsd:   lastMonthRevUsd.toFixed(2),
      monthGrowth,

      // الأرباح
      totalProfitUsd:    totalProfitUsd.toFixed(2),
      completedProfUsd:  completedProfUsd.toFixed(2),
      todayProfitUsd:    todayProfitUsd.toFixed(2),
      monthProfitUsd:    monthProfitUsd.toFixed(2),
      lastMonthProfUsd:  lastMonthProfUsd.toFixed(2),
      profitMarginPct:   (profitMargin * 100).toFixed(0),

      // الإيداعات
      totalDepositsUsd:  totalDepositsUsd.toFixed(2),
      totalDepositsCount: totalDeposits._count.id,
      todayDepositsUsd:  todayDepositsUsd.toFixed(2),
      todayDepositsCount: todayDeposits._count.id,
      monthDepositsUsd:  monthDepositsUsd.toFixed(2),
      monthDepositsCount: monthDeposits._count.id,

      // السحوبات
      totalWithdrawUsd:  totalWithdrawUsd.toFixed(2),
      totalWithdrawCount: totalWithdrawals._count.id,
      monthWithdrawUsd:  monthWithdrawUsd.toFixed(2),
      monthWithdrawCount: monthWithdrawals._count.id,

      // العمولات
      totalCommUsd:      totalCommUsd.toFixed(2),
      totalCommCount:    totalCommissions._count.id,
      monthCommUsd:      monthCommUsd.toFixed(2),

      // صافي
      netBalanceUsd:     netBalanceUsd.toFixed(2),

      // الجداول
      latestOrders,
      latestDeposits,
      topProducts: topProductsWithDetails,
    });

  } catch (err) {
    console.error('[DASHBOARD]', err);
    res.render('error', { title: 'خطأ', message: err.message });
  }
}

module.exports = { index };
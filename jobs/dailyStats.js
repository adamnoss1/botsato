const cron   = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─────────────────────────────────────────
// GENERATE DAILY STATISTICS
// Every day at midnight 00:00
// ─────────────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  try {
    const now       = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const endOfYesterday = new Date(yesterday);
    endOfYesterday.setHours(23, 59, 59, 999);

    // ── New users ──
    const newUsers = await prisma.user.count({
      where: {
        createdAt: { gte: yesterday, lte: endOfYesterday },
      },
    });

    // ── Total orders ──
    const ordersStats = await prisma.order.aggregate({
      where: {
        createdAt: { gte: yesterday, lte: endOfYesterday },
      },
      _count: { id: true },
      _sum:   { totalPrice: true },
    });

    // ── Approved deposits ──
    const depositsStats = await prisma.deposit.aggregate({
      where: {
        status:    'APPROVED',
        approvedAt: { gte: yesterday, lte: endOfYesterday },
      },
      _count: { id: true },
      _sum:   { amountUsd: true },
    });

    // ── Completed withdrawals ──
    const withdrawStats = await prisma.withdrawal.aggregate({
      where: {
        status:      'COMPLETED',
        completedAt: { gte: yesterday, lte: endOfYesterday },
      },
      _count: { id: true },
      _sum:   { netAmount: true },
    });

    // ── Manual orders ──
    const manualOrdersCount = await prisma.manualOrder.count({
      where: {
        createdAt: { gte: yesterday, lte: endOfYesterday },
      },
    });

    // ── Referral commissions ──
    const referralStats = await prisma.referral.aggregate({
      where: {
        createdAt: { gte: yesterday, lte: endOfYesterday },
      },
      _sum: { commission: true },
    });

    const statsText =
      `📊 *إحصائيات يوم ${yesterday.toLocaleDateString('ar')}*\n\n` +
      `👤 مستخدمون جدد: *${newUsers}*\n` +
      `📦 طلبات: *${ordersStats._count.id}*\n` +
      `💰 إيرادات الطلبات: *${parseFloat(ordersStats._sum.totalPrice || 0).toFixed(2)}$*\n` +
      `💳 إيداعات مقبولة: *${depositsStats._count.id}* (${parseFloat(depositsStats._sum.amountUsd || 0).toFixed(2)}$)\n` +
      `💸 سحوبات مكتملة: *${withdrawStats._count.id}* (${parseFloat(withdrawStats._sum.netAmount || 0).toFixed(2)}$)\n` +
      `⚙️ طلبات يدوية: *${manualOrdersCount}*\n` +
      `👥 عمولات إحالة: *${parseFloat(referralStats._sum.commission || 0).toFixed(2)}$*`;

    // Send to notification channel
    try {
      const config = require('../config/settings');
      const { bot } = require('../bot/bot');
      if (bot && config.bot.notificationChannelId) {
        await bot.telegram.sendMessage(
          config.bot.notificationChannelId,
          statsText,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (_) {}

    if (global.logger) {
      global.logger.info(`[JOB:dailyStats] Daily stats generated for ${yesterday.toDateString()}`);
      global.logger.info(`[JOB:dailyStats] Users: ${newUsers}, Orders: ${ordersStats._count.id}, Revenue: ${ordersStats._sum.totalPrice || 0}$`);
    }

  } catch (err) {
    if (global.logger) global.logger.error(`[JOB:dailyStats] ${err.message}`);
  }
});

if (global.logger) global.logger.info('✅ Job registered: dailyStats (daily at midnight)');
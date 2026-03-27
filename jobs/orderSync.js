// jobs/orderSync.js
const cron             = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const satofill         = require('../satofill/satofillClient');

const prisma  = new PrismaClient();
let isRunning = false;

// ─────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────
function log(msg) {
  if (global.logger) global.logger.info('[SYNC] ' + msg);
  else console.log('[SYNC] ' + msg);
}
function logError(msg) {
  if (global.logger) global.logger.error('[SYNC] ' + msg);
  else console.error('[SYNC] ' + msg);
}

// ─────────────────────────────────────────
// NOTIFY USER — مع دعم الأكواد والاشتراكات
// ─────────────────────────────────────────
async function notifyUser(userId, message) {
  try {
    const { bot } = require('../bot/bot');
    if (!bot) return;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;
    await bot.telegram.sendMessage(
      Number(user.telegramId),
      message,
      { parse_mode: 'Markdown' }
    );
  } catch (_) {}
}

// ─────────────────────────────────────────
// بناء رسالة الاكتمال حسب نوع المنتج
// ─────────────────────────────────────────
function buildCompletionMessage(orderId, result) {
  let msg = `✅ *تم إكمال طلبك #${orderId} بنجاح!*\n\n`;

  // ── منتجات الأكواد ──
  if (result.codes && result.codes.length > 0) {
    msg += `🎟️ *الأكواد الخاصة بك:*\n`;
    result.codes.forEach((code, i) => {
      msg += `\`${code}\`\n`;
    });
    msg += `\n_احتفظ بهذه الأكواد في مكان آمن_`;
    return msg;
  }

  // ── منتجات الاشتراك ──
  if (result.subscriptionDetails) {
    const sub = result.subscriptionDetails;
    msg += `📧 *تفاصيل الاشتراك:*\n\n`;
    if (sub.email)    msg += `📩 البريد: \`${sub.email}\`\n`;
    if (sub.password) msg += `🔑 كلمة المرور: \`${sub.password}\`\n`;
    if (sub.url)      msg += `🔗 الرابط: ${sub.url}\n`;
    if (sub.notes)    msg += `\n📝 ملاحظات: ${sub.notes}`;
    return msg;
  }

  // ── منتجات عادية ──
  return msg + `شكراً لاستخدامك خدماتنا! 🙏`;
}

// ─────────────────────────────────────────
// REFUND HELPER
// ─────────────────────────────────────────
async function refundOrder(tx, order, newStatus) {
  const refundAmount = parseFloat(order.totalPrice);

  await tx.order.update({
    where: { id: order.id },
    data: {
      status:    newStatus,
      adminNote: 'Satofill: ' + newStatus + ' — تم استرداد الرصيد',
      updatedAt: new Date(),
    },
  });

  const user = await tx.user.findUnique({ where: { id: order.userId } });
  if (!user) return;

  const before = parseFloat(user.balance);
  const after  = parseFloat((before + refundAmount).toFixed(4));

  await tx.user.update({ where: { id: order.userId }, data: { balance: after } });

  await tx.walletTransaction.create({
    data: {
      userId:        order.userId,
      type:          'REFUND',
      amount:        refundAmount,
      balanceBefore: before,
      balanceAfter:  after,
      description:   'استرداد — طلب #' + order.id + ' (' + newStatus + ')',
      refId:         String(order.id),
    },
  });

  log('Refunded ' + refundAmount + '$ to user #' + order.userId + ' for order #' + order.id);
}

// ─────────────────────────────────────────
// PARTIAL REFUND HELPER
// ─────────────────────────────────────────
async function handlePartial(tx, order, result) {
  const remains      = parseInt(result.remains) || 0;
  const pricePerUnit = parseFloat(order.pricePerUnit) || 0;
  const refundAmount = remains > 0
    ? parseFloat((pricePerUnit * remains).toFixed(4))
    : 0;

  await tx.order.update({
    where: { id: order.id },
    data: {
      status:     'PARTIAL',
      remains,
      startCount: result.startCount || null,
      adminNote:  'اكتمل جزئياً — متبقي: ' + remains,
      updatedAt:  new Date(),
    },
  });

  if (refundAmount > 0) {
    const user = await tx.user.findUnique({ where: { id: order.userId } });
    if (user) {
      const before = parseFloat(user.balance);
      const after  = parseFloat((before + refundAmount).toFixed(4));
      await tx.user.update({ where: { id: order.userId }, data: { balance: after } });
      await tx.walletTransaction.create({
        data: {
          userId:        order.userId,
          type:          'REFUND',
          amount:        refundAmount,
          balanceBefore: before,
          balanceAfter:  after,
          description:   'استرداد جزئي — طلب #' + order.id,
          refId:         String(order.id),
        },
      });
    }
  }

  log('Partial order #' + order.id + ' remains=' + remains + ' refund=' + refundAmount + '$');
}

// ─────────────────────────────────────────
// MAIN SYNC FUNCTION
// ─────────────────────────────────────────
async function runSync() {
  const activeOrders = await prisma.order.findMany({
    where: {
      status:          { in: ['PENDING', 'PROCESSING'] },
      satofillOrderId: { not: null },
    },
    take:    50,
    orderBy: { createdAt: 'asc' },
  });

  log('Cycle start — active orders: ' + activeOrders.length);
  if (activeOrders.length === 0) return;

  for (const order of activeOrders) {
    try {
      log('Checking #' + order.id + ' satofill=' + order.satofillOrderId);

      const result    = await satofill.checkOrderStatus(order.satofillOrderId);
      const rawStatus = result.status;
      const newStatus = satofill.mapStatus(rawStatus);

      log('Order #' + order.id +
        ' raw="' + rawStatus +
        '" mapped="' + newStatus +
        '" current="' + order.status + '"'
      );

      if (newStatus === order.status) {
        log('Order #' + order.id + ' — no change');
        continue;
      }

      log('Order #' + order.id + ' UPDATING: ' + order.status + ' → ' + newStatus);

      // ── FAILED أو CANCELLED → استرداد كامل ──
      if (newStatus === 'FAILED' || newStatus === 'CANCELLED') {
        await prisma.$transaction(async (tx) => {
          await refundOrder(tx, order, newStatus);
        });

        const emoji = newStatus === 'CANCELLED' ? '🚫' : '❌';
        const label = newStatus === 'CANCELLED' ? 'ملغى' : 'مرفوض';
        await notifyUser(
          order.userId,
          `${emoji} *تحديث طلب #${order.id}*\n\n` +
          `الحالة: *${label}*\n` +
          `تم إعادة *${parseFloat(order.totalPrice).toFixed(2)}$* لرصيدك.`
        );

      // ── PARTIAL → استرداد جزئي ──
      } else if (newStatus === 'PARTIAL') {
        await prisma.$transaction(async (tx) => {
          await handlePartial(tx, order, result);
        });

        await notifyUser(
          order.userId,
          `⚠️ *طلبك #${order.id} اكتمل جزئياً*\n\n` +
          `المتبقي: *${result.remains || 0}*\n` +
          `تم استرداد قيمة المتبقي لرصيدك.`
        );

      // ── COMPLETED ──
      } else if (newStatus === 'COMPLETED') {
        // ✅ حفظ الأكواد وتفاصيل الاشتراك في قاعدة البيانات
        const codesJson = result.codes && result.codes.length > 0
          ? JSON.stringify(result.codes)
          : null;

        await prisma.order.update({
          where: { id: order.id },
          data: {
            status:     'COMPLETED',
            startCount: result.startCount || null,
            remains:    0,
            // حفظ الأكواد في adminNote مؤقتاً
            adminNote:  codesJson ? 'codes: ' + codesJson : null,
            updatedAt:  new Date(),
          },
        });

        // ✅ إرسال رسالة مخصصة حسب نوع المنتج
        const completionMsg = buildCompletionMessage(order.id, result);
        await notifyUser(order.userId, completionMsg);

        log('Order #' + order.id + ' completed' +
          (result.codes && result.codes.length > 0 ? ' with ' + result.codes.length + ' codes' : '') +
          (result.subscriptionDetails ? ' with subscription details' : '')
        );

      // ── PROCESSING أو PENDING ──
      } else {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status:     newStatus,
            startCount: result.startCount || null,
            remains:    result.remains    || null,
            updatedAt:  new Date(),
          },
        });
      }

    } catch (err) {
      logError('Error on order #' + order.id + ': ' + err.message);
    }
  }

  log('Cycle done');
}

// ─────────────────────────────────────────
// CRON — كل دقيقة
// ─────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  if (isRunning) {
    log('Already running — skip');
    return;
  }
  isRunning = true;
  try {
    await runSync();
  } catch (err) {
    logError('Cron error: ' + err.message);
  } finally {
    isRunning = false;
  }
});

log('Job registered — every 1 minute');

module.exports = { runSync };
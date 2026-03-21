// jobs/orderSync.js
const cron   = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma   = new PrismaClient();
const satofill = require('../satofill/satofillClient');

var isRunning = false;

// ─────────────────────────────────────────
// SYNC ORDER STATUSES
// ─────────────────────────────────────────
async function syncOrderStatuses() {
  var activeOrders = await prisma.order.findMany({
    where: {
      status: { in: ['PENDING', 'PROCESSING'] },
    },
    take: 50,
    orderBy: { createdAt: 'desc' },
  });

  if (global.logger) {
    global.logger.info('[SYNC] Active orders: ' + activeOrders.length);
  }

  if (activeOrders.length === 0) return 0;

  var synced = 0;

  for (var i = 0; i < activeOrders.length; i++) {
    var order = activeOrders[i];

    if (!order.satofillOrderId) {
      if (global.logger) {
        global.logger.warn('[SYNC] Order #' + order.id + ' has no satofillOrderId — skip');
      }
      continue;
    }

    try {
      if (global.logger) {
        global.logger.info('[SYNC] Checking order #' + order.id + ' → satofill #' + order.satofillOrderId);
      }

      var result    = await satofill.checkOrderStatus(order.satofillOrderId);
      var newStatus = satofill.mapStatus(result.status);

      if (global.logger) {
        global.logger.info(
          '[SYNC] Order #' + order.id +
          ' satofill="' + result.status + '"' +
          ' mapped="' + newStatus + '"' +
          ' current="' + order.status + '"'
        );
      }

      if (newStatus === order.status) continue;

      if (global.logger) {
        global.logger.info('[SYNC] Order #' + order.id + ' UPDATING: ' + order.status + ' -> ' + newStatus);
      }

      if (newStatus === 'FAILED' || newStatus === 'CANCELLED') {
        await doRefund(order, newStatus, result);
      } else if (newStatus === 'PARTIAL') {
        await doPartialRefund(order, result);
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

        if (newStatus === 'COMPLETED') {
          await notifyUser(
            order.userId,
            '✅ تم إكمال طلبك #' + order.id + ' بنجاح!'
          ).catch(function() {});
        }
      }

      synced++;

    } catch (err) {
      if (global.logger) {
        global.logger.error('[SYNC] Order #' + order.id + ' error: ' + err.message);
      }
    }
  }

  if (global.logger && synced > 0) {
    global.logger.info('[SYNC] Updated ' + synced + ' orders');
  }

  return synced;
}

// ─────────────────────────────────────────
// FULL REFUND
// ─────────────────────────────────────────
async function doRefund(order, newStatus, result) {
  var refundAmount = parseFloat(order.totalPrice);

  await prisma.$transaction(async function(tx) {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status:    newStatus,
        remains:   (result && result.remains) ? result.remains : null,
        adminNote: 'Satofill: ' + ((result && result.status) || newStatus) + ' — رصيد مسترد',
        updatedAt: new Date(),
      },
    });

    var user = await tx.user.findUnique({ where: { id: order.userId } });
    if (!user) return;

    var before = parseFloat(user.balance);
    var after  = before + refundAmount;

    await tx.user.update({
      where: { id: order.userId },
      data:  { balance: after },
    });

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
  });

  if (global.logger) {
    global.logger.info(
      '[SYNC] Refunded ' + refundAmount + '$ to user #' + order.userId +
      ' for order #' + order.id
    );
  }

  var emoji = newStatus === 'CANCELLED' ? '🚫' : '❌';
  var label = newStatus === 'CANCELLED' ? 'ملغى' : 'مرفوض';

  await notifyUser(
    order.userId,
    emoji + ' تحديث طلب #' + order.id + '\n' +
    'الحالة: ' + label + '\n' +
    'تم إعادة ' + refundAmount.toFixed(2) + '$ لرصيدك.'
  ).catch(function() {});
}

// ─────────────────────────────────────────
// PARTIAL REFUND
// ─────────────────────────────────────────
async function doPartialRefund(order, result) {
  var remains      = parseInt(result.remains) || 0;
  var pricePerUnit = parseFloat(order.pricePerUnit) || 0;
  var refundAmount = remains > 0 ? parseFloat((pricePerUnit * remains).toFixed(4)) : 0;

  await prisma.$transaction(async function(tx) {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status:     'PARTIAL',
        remains:    remains,
        startCount: result.startCount || null,
        adminNote:  'جزئي — استُردّ ' + refundAmount + '$',
        updatedAt:  new Date(),
      },
    });

    if (refundAmount > 0) {
      var user = await tx.user.findUnique({ where: { id: order.userId } });
      if (!user) return;

      var before = parseFloat(user.balance);
      var after  = before + refundAmount;

      await tx.user.update({
        where: { id: order.userId },
        data:  { balance: after },
      });

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
  });

  await notifyUser(
    order.userId,
    '⚠️ طلبك #' + order.id + ' اكتمل جزئياً\n' +
    'المتبقي: ' + remains + '\n' +
    (refundAmount > 0 ? 'تم استرداد ' + refundAmount.toFixed(2) + '$' : '')
  ).catch(function() {});
}

// ─────────────────────────────────────────
// NOTIFY USER
// ─────────────────────────────────────────
async function notifyUser(userId, message) {
  try {
    var botModule = require('../bot/bot');
    var bot       = botModule.bot;
    if (!bot) return;
    var user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;
    await bot.telegram.sendMessage(Number(user.telegramId), message);
  } catch (_) {}
}

// ─────────────────────────────────────────
// CRON — كل دقيقة
// ─────────────────────────────────────────
cron.schedule('* * * * *', async function() {
  if (isRunning) return;
  isRunning = true;
  try {
    await syncOrderStatuses();
  } catch (err) {
    if (global.logger) global.logger.error('[SYNC] Cron error: ' + err.message);
  } finally {
    isRunning = false;
  }
});

if (global.logger) global.logger.info('Job registered: orderSync (every 1 min)');

module.exports = { syncOrderStatuses };
```

---

بعد الرفع ستظهر في الـ logs خلال دقيقة:
```
Job registered: orderSync (every 1 min)   ← دليل التشغيل
[SYNC] Active orders: 1
[SYNC] Checking order #3 → satofill #285921
[SYNC] Order #3 satofill="rejected" mapped="FAILED"
[SYNC] Order #3 UPDATING: PROCESSING -> FAILED
[SYNC] Refunded X.XX$ to user #X for order #3
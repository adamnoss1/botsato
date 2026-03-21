const cron   = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma   = new PrismaClient();
const satofill = require('../satofill/satofillClient');

var isRunning = false;

async function doRefund(order, newStatus) {
  var refundAmount = parseFloat(order.totalPrice);
  await prisma.$transaction(async function(tx) {
    await tx.order.update({
      where: { id: order.id },
      data:  { status: newStatus, adminNote: 'Satofill rejected — refunded', updatedAt: new Date() },
    });
    var user = await tx.user.findUnique({ where: { id: order.userId } });
    if (!user) return;
    var before = parseFloat(user.balance);
    var after  = before + refundAmount;
    await tx.user.update({ where: { id: order.userId }, data: { balance: after } });
    await tx.walletTransaction.create({
      data: {
        userId: order.userId, type: 'REFUND',
        amount: refundAmount, balanceBefore: before, balanceAfter: after,
        description: 'استرداد — طلب #' + order.id + ' (' + newStatus + ')',
        refId: String(order.id),
      },
    });
  });

  if (global.logger) {
    global.logger.info('[SYNC] Refunded ' + refundAmount + '$ to user #' + order.userId);
  }

  try {
    var bot  = require('../bot/bot').bot;
    var user = await prisma.user.findUnique({ where: { id: order.userId } });
    if (bot && user) {
      var emoji = newStatus === 'CANCELLED' ? '🚫' : '❌';
      var label = newStatus === 'CANCELLED' ? 'ملغى' : 'مرفوض';
      await bot.telegram.sendMessage(
        Number(user.telegramId),
        emoji + ' تحديث طلب #' + order.id + '\nالحالة: ' + label +
        '\nتم إعادة ' + refundAmount.toFixed(2) + '$ لرصيدك.'
      );
    }
  } catch (_) {}
}

async function doComplete(order, result) {
  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: 'COMPLETED',
      startCount: result.startCount || null,
      remains: 0,
      updatedAt: new Date(),
    },
  });
  try {
    var bot  = require('../bot/bot').bot;
    var user = await prisma.user.findUnique({ where: { id: order.userId } });
    if (bot && user) {
      await bot.telegram.sendMessage(
        Number(user.telegramId),
        '✅ تم إكمال طلبك #' + order.id + ' بنجاح!'
      );
    }
  } catch (_) {}
}

async function doPartial(order, result) {
  var remains      = parseInt(result.remains) || 0;
  var pricePerUnit = parseFloat(order.pricePerUnit) || 0;
  var refundAmount = remains > 0 ? parseFloat((pricePerUnit * remains).toFixed(4)) : 0;

  await prisma.$transaction(async function(tx) {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'PARTIAL', remains: remains,
        startCount: result.startCount || null,
        adminNote: 'partial — refunded ' + refundAmount + '$',
        updatedAt: new Date(),
      },
    });
    if (refundAmount > 0) {
      var user = await tx.user.findUnique({ where: { id: order.userId } });
      if (!user) return;
      var before = parseFloat(user.balance);
      var after  = before + refundAmount;
      await tx.user.update({ where: { id: order.userId }, data: { balance: after } });
      await tx.walletTransaction.create({
        data: {
          userId: order.userId, type: 'REFUND',
          amount: refundAmount, balanceBefore: before, balanceAfter: after,
          description: 'استرداد جزئي — طلب #' + order.id,
          refId: String(order.id),
        },
      });
    }
  });

  try {
    var bot  = require('../bot/bot').bot;
    var user = await prisma.user.findUnique({ where: { id: order.userId } });
    if (bot && user) {
      await bot.telegram.sendMessage(
        Number(user.telegramId),
        '⚠️ طلبك #' + order.id + ' اكتمل جزئياً\n' +
        'المتبقي: ' + remains + '\n' +
        (refundAmount > 0 ? 'تم استرداد ' + refundAmount.toFixed(2) + '$' : '')
      );
    }
  } catch (_) {}
}

async function runSync() {
  var activeOrders = await prisma.order.findMany({
    where: { status: { in: ['PENDING', 'PROCESSING'] } },
    take: 50,
    orderBy: { createdAt: 'desc' },
  });

  console.log('[SYNC] Running — active orders: ' + activeOrders.length);

  if (activeOrders.length === 0) return 0;

  var synced = 0;

  for (var i = 0; i < activeOrders.length; i++) {
    var order = activeOrders[i];

    if (!order.satofillOrderId) {
      console.log('[SYNC] Order #' + order.id + ' — no satofillOrderId, skip');
      continue;
    }

    try {
      console.log('[SYNC] Checking #' + order.id + ' satofill=' + order.satofillOrderId);

      var result    = await satofill.checkOrderStatus(order.satofillOrderId);
      var newStatus = satofill.mapStatus(result.status);

      console.log('[SYNC] #' + order.id + ' satofill="' + result.status + '" mapped="' + newStatus + '" current="' + order.status + '"');

      if (newStatus === order.status) {
        console.log('[SYNC] #' + order.id + ' — no change');
        continue;
      }

      console.log('[SYNC] #' + order.id + ' UPDATING: ' + order.status + ' -> ' + newStatus);

      if (newStatus === 'FAILED' || newStatus === 'CANCELLED') {
        await doRefund(order, newStatus);
      } else if (newStatus === 'PARTIAL') {
        await doPartial(order, result);
      } else if (newStatus === 'COMPLETED') {
        await doComplete(order, result);
      } else {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: newStatus,
            startCount: result.startCount || null,
            remains: result.remains || null,
            updatedAt: new Date(),
          },
        });
      }

      synced++;

    } catch (err) {
      console.error('[SYNC] Order #' + order.id + ' ERROR: ' + err.message);
    }
  }

  console.log('[SYNC] Done — synced ' + synced + ' orders');
  return synced;
}

// ─── CRON كل دقيقة ───
cron.schedule('* * * * *', async function() {
  if (isRunning) {
    console.log('[SYNC] Still running, skip');
    return;
  }
  isRunning = true;
  try {
    await runSync();
  } catch (err) {
    console.error('[SYNC] Cron error: ' + err.message);
  } finally {
    isRunning = false;
  }
});

// هذا السطر يُثبت أن الملف تم تحميله
console.log('[SYNC] Job registered — orderSync every 1 min');
if (global.logger) global.logger.info('Job registered: orderSync (every 1 min)');

module.exports = { runSync };
const { PrismaClient } = require('@prisma/client');
const prisma   = new PrismaClient();
const satofill = require('../satofill/satofillClient');
const { debitBalance } = require('./walletService');
const { creditReferral } = require('./referralService');

var productCache   = [];
var cacheUpdatedAt = null;

async function refreshProductCache() {
  try {
    var services = await satofill.getServices();
    productCache   = services;
    cacheUpdatedAt = new Date();
    return services;
  } catch (err) {
    if (global.logger) global.logger.error('[ORDER] Cache refresh failed: ' + err.message);
    return productCache;
  }
}

function getProductCache() {
  return { products: productCache, updatedAt: cacheUpdatedAt };
}

function calculatePrice(priceUsd, quantity, profitMargin, exchangeRate, vipDiscount) {
  vipDiscount = vipDiscount || 0;
  var base       = parseFloat(priceUsd) * parseInt(quantity);
  var withProfit = base * (1 + parseFloat(profitMargin));
  var discount   = withProfit * parseFloat(vipDiscount);
  var finalUsd   = withProfit - discount;
  var finalLocal = finalUsd * parseFloat(exchangeRate);
  return {
    baseUsd:    parseFloat(base.toFixed(6)),
    finalUsd:   parseFloat(finalUsd.toFixed(6)),
    finalLocal: parseFloat(finalLocal.toFixed(4)),
  };
}

async function getVipDiscount(vipLevel) {
  var settingsSvc = require('./settingsService');
  var map = {
    NORMAL: 0,
    BRONZE: parseFloat(await settingsSvc.getSetting('vip_bronze_discount') || '0.02'),
    SILVER: parseFloat(await settingsSvc.getSetting('vip_silver_discount') || '0.05'),
    GOLD:   parseFloat(await settingsSvc.getSetting('vip_gold_discount')   || '0.10'),
  };
  return map[vipLevel] || 0;
}

async function checkDuplicateOrder(userId, productId) {
  var fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  var existing = await prisma.order.findFirst({
    where: {
      userId:    parseInt(userId),
      productId: parseInt(productId),
      createdAt: { gte: fiveMinutesAgo },
      status:    { notIn: ['CANCELLED', 'FAILED'] },
    },
  });
  return !!existing;
}

async function createAutoOrder(userId, productId, quantity, link) {
  var product = await prisma.product.findUnique({
    where:   { id: parseInt(productId) },
    include: { group: true },
  });

  if (!product || !product.isActive) throw new Error('الخدمة غير متاحة');
  if (product.isManual)              throw new Error('هذه خدمة يدوية');
  if (!product.satofillId)           throw new Error('الخدمة غير مرتبطة بـ Satofill');

  var qty = parseInt(quantity);
  if (qty < product.minQuantity) throw new Error('الحد الأدنى ' + product.minQuantity);
  if (qty > product.maxQuantity) throw new Error('الحد الأقصى ' + product.maxQuantity);

  var user     = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
  var discount = await getVipDiscount(user.vipLevel);

  var settingsSvc  = require('./settingsService');
  var exchangeRate = parseFloat(await settingsSvc.getSetting('exchange_rate') || '3.75');
  var profitMargin = parseFloat(await settingsSvc.getSetting('profit_margin') || '0.20');

  var pricePerUnit = parseFloat(product.priceUsd) * (1 + profitMargin) * (1 - discount);
  var totalPrice   = parseFloat((pricePerUnit * qty * exchangeRate).toFixed(4));

  if (parseFloat(user.balance) < totalPrice) {
    throw new Error('رصيد غير كافٍ. المطلوب: ' + totalPrice.toFixed(2) + '$');
  }

  var order = await prisma.order.create({
    data: {
      userId:      parseInt(userId),
      productId:   parseInt(productId),
      quantity:    qty,
      link,
      pricePerUnit,
      totalPrice,
      status:      'PENDING',
    },
  });

  await debitBalance(
    parseInt(userId),
    totalPrice,
    'ORDER',
    'طلب خدمة: ' + product.name,
    String(order.id)
  );

  try {
    var satofillResult = await satofill.createOrder({
      serviceId: product.satofillId,
      quantity:  qty,
      link,
    });

    await prisma.order.update({
      where: { id: order.id },
      data:  { satofillOrderId: satofillResult.satofillOrderId, status: 'PROCESSING' },
    });

    if (global.logger) {
      global.logger.info('[ORDER] #' + order.id + ' → Satofill #' + satofillResult.satofillOrderId);
    }

  } catch (err) {
    await prisma.order.update({
      where: { id: order.id },
      data:  { status: 'FAILED', adminNote: err.message },
    });

    var walletSvc = require('./walletService');
    await walletSvc.creditBalance(
      parseInt(userId),
      totalPrice,
      'REFUND',
      'استرداد — فشل إنشاء الطلب',
      String(order.id)
    );

    throw new Error('فشل إنشاء الطلب: ' + err.message);
  }

  await creditReferral(parseInt(userId), order.id, totalPrice).catch(function() {});

  return order;
}

async function createManualOrder(userId, productId, quantity, accountInfo) {
  var product = await prisma.product.findUnique({
    where: { id: parseInt(productId) },
  });

  if (!product || !product.isActive || !product.isManual) {
    throw new Error('الخدمة غير متاحة');
  }

  var qty  = parseInt(quantity);
  var user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });

  var settingsSvc  = require('./settingsService');
  var exchangeRate = parseFloat(await settingsSvc.getSetting('exchange_rate') || '3.75');
  var totalPrice   = parseFloat((parseFloat(product.priceUsd) * qty * exchangeRate).toFixed(4));

  if (parseFloat(user.balance) < totalPrice) {
    throw new Error('رصيد غير كافٍ. المطلوب: ' + totalPrice.toFixed(2));
  }

  var manualOrder = await prisma.manualOrder.create({
    data: {
      userId:     parseInt(userId),
      productId:  parseInt(productId),
      quantity:   qty,
      accountInfo,
      totalPrice,
      status:     'PENDING',
    },
  });

  await debitBalance(
    parseInt(userId),
    totalPrice,
    'ORDER',
    'طلب يدوي: ' + product.name,
    String(manualOrder.id)
  );

  var notifySvc = require('./notificationService');
  await notifySvc.notifyAdminsManualOrder(manualOrder, user, product).catch(function() {});

  return manualOrder;
}

async function getOrders(options) {
  options = options || {};
  var page   = options.page   || 1;
  var limit  = options.limit  || 20;
  var status = options.status || null;
  var userId = options.userId || null;
  var skip   = (page - 1) * limit;
  var where  = {};

  if (status) where.status = status;
  if (userId) where.userId = parseInt(userId);

  var results = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take:    limit,
      orderBy: { createdAt: 'desc' },
      include: { user: true, product: true },
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: results[0],
    total:  results[1],
    pages:  Math.ceil(results[1] / limit),
    page,
  };
}

async function notifyUserOrderRefunded(order, status) {
  try {
    var bot = require('../bot/bot').bot;
    if (!bot) return;
    var user = await prisma.user.findUnique({ where: { id: order.userId } });
    if (!user) return;
    var emoji = status === 'CANCELLED' ? '🚫' : '❌';
    var label = status === 'CANCELLED' ? 'ملغى' : 'فاشل';
    await bot.telegram.sendMessage(
      Number(user.telegramId),
      emoji + ' *تحديث طلب #' + order.id + '*\n\n' +
      'الحالة: *' + label + '*\n' +
      'تم إعادة *' + parseFloat(order.totalPrice).toFixed(2) + '$* لرصيدك.',
      { parse_mode: 'Markdown' }
    );
  } catch (_) {}
}

async function notifyUserOrderCompleted(order) {
  try {
    var bot = require('../bot/bot').bot;
    if (!bot) return;
    var user = await prisma.user.findUnique({ where: { id: order.userId } });
    if (!user) return;
    await bot.telegram.sendMessage(
      Number(user.telegramId),
      '✅ *تم إكمال طلبك #' + order.id + ' بنجاح!*',
      { parse_mode: 'Markdown' }
    );
  } catch (_) {}
}

async function notifyUserOrderPartial(order, remains) {
  try {
    var bot = require('../bot/bot').bot;
    if (!bot) return;
    var user = await prisma.user.findUnique({ where: { id: order.userId } });
    if (!user) return;
    await bot.telegram.sendMessage(
      Number(user.telegramId),
      '⚠️ *طلبك #' + order.id + ' اكتمل جزئياً*\n' +
      'الكمية المتبقية: *' + remains + '*\n' +
      'تم استرداد قيمة المتبقي لرصيدك.',
      { parse_mode: 'Markdown' }
    );
  } catch (_) {}
}

async function handlePartialRefund(order, result) {
  var remains = result.remains || 0;

  await prisma.$transaction(async function(tx) {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status:     'PARTIAL',
        remains,
        startCount: result.startCount,
        adminNote:  'طلب جزئي',
      },
    });

    if (remains > 0) {
      var pricePerUnit = parseFloat(order.pricePerUnit);
      var refundAmount = parseFloat((pricePerUnit * remains).toFixed(4));

      if (refundAmount > 0) {
        var user = await tx.user.findUnique({ where: { id: order.userId } });
        if (!user) return;

        var balanceBefore = parseFloat(user.balance);
        var balanceAfter  = balanceBefore + refundAmount;

        await tx.user.update({
          where: { id: order.userId },
          data:  { balance: balanceAfter },
        });

        await tx.walletTransaction.create({
          data: {
            userId:        order.userId,
            type:          'REFUND',
            amount:        refundAmount,
            balanceBefore,
            balanceAfter,
            description:   'استرداد جزئي — طلب #' + order.id,
            refId:         String(order.id),
          },
        });
      }
    }
  });

  await notifyUserOrderPartial(order, remains).catch(function() {});
}

async function syncOrderStatuses() {
  var activeOrders = await prisma.order.findMany({
    where: {
      status:          { in: ['PENDING', 'PROCESSING'] },
      satofillOrderId: { not: null },
    },
    take: 50,
  });

  if (activeOrders.length === 0) return 0;

  var synced = 0;

  for (var i = 0; i < activeOrders.length; i++) {
    var order = activeOrders[i];
    try {
      var result    = await satofill.checkOrderStatus(order.satofillOrderId);
      var newStatus = satofill.mapStatus(result.status);

      if (newStatus === order.status) continue;

      if (global.logger) {
        global.logger.info(
          '[SYNC] Order #' + order.id +
          ': ' + order.status + ' -> ' + newStatus
        );
      }

      var refundStatuses = ['CANCELLED', 'FAILED'];

      if (refundStatuses.includes(newStatus)) {
        var orderRef = order;
        await prisma.$transaction(async function(tx) {
          await tx.order.update({
            where: { id: orderRef.id },
            data: {
              status:    newStatus,
              remains:   result.remains,
              adminNote: 'رفض Satofill — استُردّ الرصيد',
              updatedAt: new Date(),
            },
          });

          var user = await tx.user.findUnique({ where: { id: orderRef.userId } });
          if (!user) return;

          var refundAmount  = parseFloat(orderRef.totalPrice);
          var balanceBefore = parseFloat(user.balance);
          var balanceAfter  = balanceBefore + refundAmount;

          await tx.user.update({
            where: { id: orderRef.userId },
            data:  { balance: balanceAfter },
          });

          await tx.walletTransaction.create({
            data: {
              userId:        orderRef.userId,
              type:          'REFUND',
              amount:        refundAmount,
              balanceBefore,
              balanceAfter,
              description:   'استرداد — طلب #' + orderRef.id + ' (' + newStatus + ')',
              refId:         String(orderRef.id),
            },
          });
        });

        await notifyUserOrderRefunded(order, newStatus).catch(function() {});

      } else if (newStatus === 'PARTIAL') {
        await handlePartialRefund(order, result);

      } else {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status:     newStatus,
            startCount: result.startCount,
            remains:    result.remains,
            updatedAt:  new Date(),
          },
        });

        if (newStatus === 'COMPLETED') {
          await notifyUserOrderCompleted(order).catch(function() {});
        }
      }

      synced++;

    } catch (err) {
      if (global.logger) {
        global.logger.error('[SYNC] Order #' + order.id + ': ' + err.message);
      }
    }
  }

  return synced;
}

module.exports = {
  refreshProductCache,
  getProductCache,
  calculatePrice,
  checkDuplicateOrder,
  createAutoOrder,
  createManualOrder,
  getOrders,
  syncOrderStatuses,
};
// services/orderService.js
const { PrismaClient } = require('@prisma/client');
const prisma   = new PrismaClient();
const satofill = require('../satofill/satofillClient');
const { debitBalance } = require('./walletService');
const { creditReferral } = require('./referralService');

let productCache   = [];
let cacheUpdatedAt = null;

// ─────────────────────────────────────────
// PRODUCT CACHE
// ─────────────────────────────────────────
async function refreshProductCache() {
  try {
    const services = await satofill.getServices();
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

// ─────────────────────────────────────────
// PRICE CALCULATION
// ─────────────────────────────────────────
function calculatePrice(priceUsd, quantity, profitMargin, exchangeRate, vipDiscount) {
  vipDiscount  = vipDiscount  || 0;
  const base       = parseFloat(priceUsd) * parseInt(quantity);
  const withProfit = base * (1 + parseFloat(profitMargin));
  const discount   = withProfit * parseFloat(vipDiscount);
  const finalUsd   = withProfit - discount;
  const finalLocal = finalUsd * parseFloat(exchangeRate);
  return {
    baseUsd:    parseFloat(base.toFixed(6)),
    finalUsd:   parseFloat(finalUsd.toFixed(6)),
    finalLocal: parseFloat(finalLocal.toFixed(4)),
  };
}

// ─────────────────────────────────────────
// VIP DISCOUNT
// ─────────────────────────────────────────
async function getVipDiscount(vipLevel) {
  const settingsSvc = require('./settingsService');
  const map = {
    NORMAL: 0,
    BRONZE: parseFloat(await settingsSvc.getSetting('vip_bronze_discount') || '0.02'),
    SILVER: parseFloat(await settingsSvc.getSetting('vip_silver_discount') || '0.05'),
    GOLD:   parseFloat(await settingsSvc.getSetting('vip_gold_discount')   || '0.10'),
  };
  return map[vipLevel] || 0;
}

// ─────────────────────────────────────────
// CHECK DUPLICATE ORDER (آخر 5 دقائق)
// ─────────────────────────────────────────
async function checkDuplicateOrder(userId, productId) {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const existing = await prisma.order.findFirst({
    where: {
      userId:    parseInt(userId),
      productId: parseInt(productId),
      createdAt: { gte: fiveMinutesAgo },
      status:    { notIn: ['CANCELLED', 'FAILED'] },
    },
  });
  return !!existing;
}

// ─────────────────────────────────────────
// BUILD CUSTOM FIELDS
// ✅ يقرأ custom_fields من بيانات المنتج المخزنة
// ─────────────────────────────────────────
function buildCustomFields(product, userInput) {
  // إذا لم توجد custom_fields محفوظة — fallback
  if (!product.customFields) {
    return { link: userInput, url: userInput };
  }

  let fields = [];
  try {
    fields = JSON.parse(product.customFields);
  } catch (_) {
    return { link: userInput, url: userInput };
  }

  if (!Array.isArray(fields) || fields.length === 0) {
    return { link: userInput, url: userInput };
  }

  const result = {};

  for (const field of fields) {
    if (!field.key) continue;
    // كل الحقول النصية المطلوبة تأخذ قيمة userInput
    if (field.type === 'text' || field.type === 'number' || !field.type) {
      result[field.key] = userInput;
    }
  }

  // إذا لم نتمكن من تعيين أي حقل
  if (Object.keys(result).length === 0) {
    result[fields[0].key] = userInput;
  }

  if (global.logger) {
    global.logger.info('[ORDER] Built customFields: ' + JSON.stringify(result));
  }

  return result;
}

// ─────────────────────────────────────────
// CREATE AUTO ORDER
// ─────────────────────────────────────────
async function createAutoOrder(userId, productId, quantity, link) {
  const product = await prisma.product.findUnique({
    where:   { id: parseInt(productId) },
    include: { group: true },
  });

  if (!product || !product.isActive) throw new Error('الخدمة غير متاحة');
  if (product.isManual)              throw new Error('هذه خدمة يدوية');
  if (!product.satofillId)           throw new Error('الخدمة غير مرتبطة بـ Satofill');

  const qty = parseInt(quantity);
  if (qty < product.minQuantity) throw new Error('الحد الأدنى للكمية: ' + product.minQuantity);
  if (qty > product.maxQuantity) throw new Error('الحد الأقصى للكمية: ' + product.maxQuantity);

  const user     = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
  const discount = await getVipDiscount(user.vipLevel);

  const settingsSvc  = require('./settingsService');
  const exchangeRate = parseFloat(await settingsSvc.getSetting('exchange_rate') || '3.75');
  const profitMargin = parseFloat(await settingsSvc.getSetting('profit_margin') || '0.20');

  const pricePerUnit = parseFloat(product.priceUsd) * (1 + profitMargin) * (1 - discount);
  const totalPrice   = parseFloat((pricePerUnit * qty * exchangeRate).toFixed(4));

  if (parseFloat(user.balance) < totalPrice) {
    throw new Error('رصيد غير كافٍ. المطلوب: ' + totalPrice.toFixed(2) + '$');
  }

  // إنشاء الطلب في DB
  const order = await prisma.order.create({
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

  // خصم الرصيد
  await debitBalance(
    parseInt(userId),
    totalPrice,
    'ORDER',
    'طلب خدمة: ' + product.name,
    String(order.id)
  );

  try {
    // ✅ بناء custom_fields الصحيحة
    const customFields = buildCustomFields(product, link);

    if (global.logger) {
      global.logger.info(
        '[ORDER] Sending to Satofill — serviceId: ' + product.satofillId +
        ' qty: ' + qty +
        ' customFields: ' + JSON.stringify(customFields)
      );
    }

    const satofillResult = await satofill.createOrder({
      serviceId:    product.satofillId,
      quantity:     qty,
      customFields,
    });

    // تحديث الطلب بـ Satofill order ID
    const newStatus = satofillResult.status === 'completed' ? 'COMPLETED' : 'PROCESSING';
    await prisma.order.update({
      where: { id: order.id },
      data:  {
        satofillOrderId: satofillResult.satofillOrderId,
        status:          newStatus,
      },
    });

    if (global.logger) {
      global.logger.info('[ORDER] #' + order.id + ' → Satofill #' + satofillResult.satofillOrderId + ' status: ' + newStatus);
    }

  } catch (err) {
    // فشل الإرسال لـ Satofill → استرداد الرصيد
    await prisma.order.update({
      where: { id: order.id },
      data:  { status: 'FAILED', adminNote: err.message },
    });

    const walletSvc = require('./walletService');
    await walletSvc.creditBalance(
      parseInt(userId),
      totalPrice,
      'REFUND',
      'استرداد — فشل إنشاء الطلب: ' + err.message,
      String(order.id)
    );

    throw new Error('فشل إنشاء الطلب: ' + err.message);
  }

  // عمولة الإحالة
  await creditReferral(parseInt(userId), order.id, totalPrice).catch(() => {});

  return order;
}

// ─────────────────────────────────────────
// CREATE MANUAL ORDER
// ─────────────────────────────────────────
async function createManualOrder(userId, productId, quantity, accountInfo) {
  const product = await prisma.product.findUnique({
    where: { id: parseInt(productId) },
  });

  if (!product || !product.isActive || !product.isManual) {
    throw new Error('الخدمة غير متاحة');
  }

  const qty  = parseInt(quantity);
  const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });

  const settingsSvc  = require('./settingsService');
  const exchangeRate = parseFloat(await settingsSvc.getSetting('exchange_rate') || '3.75');
  const totalPrice   = parseFloat((parseFloat(product.priceUsd) * qty * exchangeRate).toFixed(4));

  if (parseFloat(user.balance) < totalPrice) {
    throw new Error('رصيد غير كافٍ. المطلوب: ' + totalPrice.toFixed(2) + '$');
  }

  const manualOrder = await prisma.manualOrder.create({
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

  const notifySvc = require('./notificationService');
  await notifySvc.notifyAdminsManualOrder(manualOrder, user, product).catch(() => {});

  return manualOrder;
}

// ─────────────────────────────────────────
// GET ORDERS (paginated)
// ─────────────────────────────────────────
async function getOrders({ page = 1, limit = 20, status = null, userId = null } = {}) {
  const skip  = (page - 1) * limit;
  const where = {};
  if (status) where.status = status;
  if (userId) where.userId = parseInt(userId);

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take:    limit,
      orderBy: { createdAt: 'desc' },
      include: { user: true, product: true },
    }),
    prisma.order.count({ where }),
  ]);

  return { orders, total, pages: Math.ceil(total / limit), page };
}

// ─────────────────────────────────────────
// SYNC ORDER STATUSES (للاستخدام من الـ job)
// ─────────────────────────────────────────
async function syncOrderStatuses() {
  const activeOrders = await prisma.order.findMany({
    where: {
      status:          { in: ['PENDING', 'PROCESSING'] },
      satofillOrderId: { not: null },
    },
    take:    50,
    orderBy: { createdAt: 'asc' },
  });

  if (activeOrders.length === 0) return 0;

  let synced = 0;

  for (const order of activeOrders) {
    try {
      const result    = await satofill.checkOrderStatus(order.satofillOrderId);
      const newStatus = satofill.mapStatus(result.status);

      if (newStatus === order.status) continue;

      if (global.logger) {
        global.logger.info(
          '[ORDER SYNC] #' + order.id +
          ' ' + order.status + ' → ' + newStatus
        );
      }

      if (newStatus === 'FAILED' || newStatus === 'CANCELLED') {
        await prisma.$transaction(async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data:  { status: newStatus, adminNote: 'Satofill: ' + result.status, updatedAt: new Date() },
          });
          const user   = await tx.user.findUnique({ where: { id: order.userId } });
          if (!user) return;
          const before = parseFloat(user.balance);
          const after  = parseFloat((before + parseFloat(order.totalPrice)).toFixed(4));
          await tx.user.update({ where: { id: order.userId }, data: { balance: after } });
          await tx.walletTransaction.create({
            data: {
              userId: order.userId, type: 'REFUND',
              amount: parseFloat(order.totalPrice),
              balanceBefore: before, balanceAfter: after,
              description: 'استرداد — طلب #' + order.id + ' (' + newStatus + ')',
              refId: String(order.id),
            },
          });
        });

      } else if (newStatus === 'PARTIAL') {
        const remains      = parseInt(result.remains) || 0;
        const refundAmount = remains > 0
          ? parseFloat((parseFloat(order.pricePerUnit) * remains).toFixed(4))
          : 0;

        await prisma.$transaction(async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data: { status: 'PARTIAL', remains, startCount: result.startCount || null, updatedAt: new Date() },
          });
          if (refundAmount > 0) {
            const user   = await tx.user.findUnique({ where: { id: order.userId } });
            if (!user) return;
            const before = parseFloat(user.balance);
            const after  = parseFloat((before + refundAmount).toFixed(4));
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

      } else if (newStatus === 'COMPLETED') {
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'COMPLETED', startCount: result.startCount || null, remains: 0, updatedAt: new Date() },
        });

      } else {
        await prisma.order.update({
          where: { id: order.id },
          data: { status: newStatus, startCount: result.startCount || null, remains: result.remains || null, updatedAt: new Date() },
        });
      }

      synced++;

    } catch (err) {
      if (global.logger) {
        global.logger.error('[ORDER SYNC] Error on #' + order.id + ': ' + err.message);
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
  buildCustomFields,
  createAutoOrder,
  createManualOrder,
  getOrders,
  syncOrderStatuses,
};
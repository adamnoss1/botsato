const { PrismaClient } = require('@prisma/client');
const prisma     = new PrismaClient();
const satofill   = require('../satofill/satofillClient');
const { debitBalance } = require('./walletService');
const { creditReferral } = require('./referralService');

// ─────────────────────────────────────────
// PRODUCT CACHE
// ─────────────────────────────────────────
let productCache = [];
let cacheUpdatedAt = null;

async function refreshProductCache() {
  try {
    const services = await satofill.getServices();
    productCache   = services;
    cacheUpdatedAt = new Date();
    return services;
  } catch (err) {
    if (global.logger) global.logger.error(`[ORDER] Cache refresh failed: ${err.message}`);
    return productCache;
  }
}

function getProductCache() {
  return { products: productCache, updatedAt: cacheUpdatedAt };
}

// ─────────────────────────────────────────
// CALCULATE ORDER PRICE
// ─────────────────────────────────────────
function calculatePrice(priceUsd, quantity, profitMargin, exchangeRate, vipDiscount = 0) {
  const base     = parseFloat(priceUsd) * parseInt(quantity);
  const withProfit = base * (1 + parseFloat(profitMargin));
  const discount   = withProfit * parseFloat(vipDiscount);
  const final      = (withProfit - discount) * parseFloat(exchangeRate);
  return {
    baseUsd:   parseFloat(base.toFixed(6)),
    finalUsd:  parseFloat((withProfit - discount).toFixed(6)),
    finalLocal: parseFloat(final.toFixed(4)),
  };
}

// ─────────────────────────────────────────
// GET VIP DISCOUNT FOR USER
// ─────────────────────────────────────────
async function getVipDiscount(vipLevel) {
  const { getSetting } = require('./settingsService');
  const map = {
    NORMAL: 0,
    BRONZE: parseFloat(await getSetting('vip_bronze_discount') || '0.02'),
    SILVER: parseFloat(await getSetting('vip_silver_discount') || '0.05'),
    GOLD:   parseFloat(await getSetting('vip_gold_discount')   || '0.10'),
  };
  return map[vipLevel] || 0;
}

// ─────────────────────────────────────────
// CHECK DUPLICATE ORDER (last 5 minutes)
// ─────────────────────────────────────────
async function checkDuplicateOrder(userId, productId) {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const existing = await prisma.order.findFirst({
    where: {
      userId:    parseInt(userId),
      productId: parseInt(productId),
      createdAt: { gte: fiveMinutesAgo },
    },
  });
  return !!existing;
}

// ─────────────────────────────────────────
// CREATE AUTO ORDER (Satofill)
// ─────────────────────────────────────────
async function createAutoOrder(userId, productId, quantity, link) {
  const product = await prisma.product.findUnique({
    where: { id: parseInt(productId) },
    include: { group: true },
  });

  if (!product || !product.isActive) throw new Error('الخدمة غير متاحة');
  if (product.isManual) throw new Error('هذه خدمة يدوية');
  if (!product.satofillId) throw new Error('الخدمة غير مرتبطة بـ Satofill');

  const qty = parseInt(quantity);
  if (qty < product.minQuantity) throw new Error(`الحد الأدنى ${product.minQuantity}`);
  if (qty > product.maxQuantity) throw new Error(`الحد الأقصى ${product.maxQuantity}`);

  const user     = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
  const discount = await getVipDiscount(user.vipLevel);

  const { getSetting } = require('./settingsService');
  const exchangeRate  = parseFloat(await getSetting('exchange_rate')  || '3.75');
  const profitMargin  = parseFloat(await getSetting('profit_margin')  || '0.20');

  const pricePerUnit = parseFloat(product.priceUsd) * (1 + profitMargin) * (1 - discount);
  const totalPrice   = parseFloat((pricePerUnit * qty * exchangeRate).toFixed(4));

  if (parseFloat(user.balance) < totalPrice) {
    throw new Error(`رصيد غير كافٍ. المطلوب: ${totalPrice.toFixed(2)}$`);
  }

  // Create order in DB first
  const order = await prisma.order.create({
    data: {
      userId:     parseInt(userId),
      productId:  parseInt(productId),
      quantity:   qty,
      link,
      pricePerUnit,
      totalPrice,
      status:     'PENDING',
    },
  });

  // Deduct balance
  await debitBalance(
    parseInt(userId),
    totalPrice,
    'ORDER',
    `طلب خدمة: ${product.name}`,
    String(order.id)
  );

  // Submit to Satofill
  try {
    const satofillResult = await satofill.createOrder({
      serviceId: product.satofillId,
      quantity:  qty,
      link,
    });

    await prisma.order.update({
      where: { id: order.id },
      data:  { satofillOrderId: satofillResult.satofillOrderId, status: 'PROCESSING' },
    });
  } catch (err) {
    await prisma.order.update({
      where: { id: order.id },
      data:  { status: 'FAILED', adminNote: err.message },
    });
    // Refund
    const { creditBalance } = require('./walletService');
    await creditBalance(
      parseInt(userId),
      totalPrice,
      'REFUND',
      'استرداد - فشل الطلب',
      String(order.id)
    );
    throw new Error(`فشل إنشاء الطلب: ${err.message}`);
  }

  // Credit referral commission
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

  const { getSetting } = require('./settingsService');
  const exchangeRate = parseFloat(await getSetting('exchange_rate') || '3.75');

  const totalPrice = parseFloat(
    (parseFloat(product.priceUsd) * qty * exchangeRate).toFixed(4)
  );

  if (parseFloat(user.balance) < totalPrice) {
    throw new Error(`رصيد غير كافٍ. المطلوب: ${totalPrice.toFixed(2)}`);
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
    `طلب يدوي: ${product.name}`,
    String(manualOrder.id)
  );

  // Notify admins
  const { notifyAdminsManualOrder } = require('./notificationService');
  await notifyAdminsManualOrder(manualOrder, user, product).catch(() => {});

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
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: true, product: true },
    }),
    prisma.order.count({ where }),
  ]);

  return { orders, total, pages: Math.ceil(total / limit), page };
}

// ─────────────────────────────────────────
// SYNC ORDER STATUSES FROM SATOFILL
// ─────────────────────────────────────────
async function syncOrderStatuses() {
  const activeOrders = await prisma.order.findMany({
    where: {
      status:         { in: ['PENDING', 'PROCESSING'] },
      satofillOrderId: { not: null },
    },
    take: 50,
  });

  if (activeOrders.length === 0) return 0;

  let synced = 0;

  for (const order of activeOrders) {
    try {
      const result = await satofill.checkOrderStatus(order.satofillOrderId);
      const newStatus = satofill.mapStatus(result.status);

      if (newStatus !== order.status) {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status:     newStatus,
            startCount: result.startCount,
            remains:    result.remains,
          },
        });
        synced++;
      }
    } catch (err) {
      if (global.logger) global.logger.error(`[SYNC] Order ${order.id}: ${err.message}`);
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
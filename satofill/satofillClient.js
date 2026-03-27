// satofill/satofillClient.js
const axios  = require('axios');
const config = require('../config/settings');

const BASE_URL = config.satofill.apiUrl || 'https://satofill.com/wp-json/mps/v1';

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  },
});

client.interceptors.request.use(function (reqConfig) {
  const token = config.satofill.apiKey;
  if (!token || token === 'your_api_token_here') {
    throw new Error('SATOFILL_API_KEY is not configured');
  }
  reqConfig.headers['Authorization'] = 'Bearer ' + token;
  return reqConfig;
});

client.interceptors.response.use(
  function (res) { return res.data; },
  function (err) {
    const status = err.response ? err.response.status : null;
    const body   = err.response ? err.response.data   : null;
    let msg = 'Satofill API error';
    if (body && body.error && body.error.message) msg = body.error.message;
    else if (body && body.error && body.error.code) msg = body.error.code;
    else if (body && body.message) msg = body.message;
    else if (err.message) msg = err.message;
    if (global.logger) global.logger.error('[SATOFILL] HTTP ' + (status || '?') + ': ' + msg);
    if (status === 401) throw new Error('مفتاح API غير صالح (401)');
    if (status === 403) throw new Error('وصول مرفوض (403): ' + msg);
    if (status === 404) throw new Error('غير موجود (404)');
    if (status === 422) throw new Error('بيانات غير صالحة (422): ' + msg);
    if (status === 429) throw new Error('تم تجاوز حد الطلبات (429)');
    throw new Error(msg);
  }
);

// ─────────────────────────────────────────
// EXTRACT PRODUCTS
// ─────────────────────────────────────────
function extractProducts(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.data && data.data.products && Array.isArray(data.data.products)) return data.data.products;
  if (data.data && Array.isArray(data.data)) return data.data;
  if (data.products && Array.isArray(data.products)) return data.products;
  return [];
}

// ─────────────────────────────────────────
// NORMALIZE PRODUCT
// ─────────────────────────────────────────
function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const serviceId = String(raw.id || raw.service_id || '').trim();
  if (!serviceId) return null;
  const name = String(raw.name || raw.title || '').trim();
  if (!name) return null;

  let categories = [];
  if (Array.isArray(raw.categories) && raw.categories.length > 0) {
    categories = raw.categories.map(c => String(c).trim()).filter(Boolean);
  } else if (raw.category) {
    categories = [String(raw.category).trim()];
  }

  const price  = parseFloat(raw.price || raw.rate || 0);
  const minQty = parseInt(String(raw.min_quantity || raw.min || 1).replace(/\D/g, '')) || 1;
  const maxQty = parseInt(String(raw.max_quantity || raw.max || 100000).replace(/\D/g, '')) || 100000;
  const customFields = Array.isArray(raw.custom_fields) ? raw.custom_fields : [];

  return {
    serviceId,
    name,
    categories,
    price,
    minQty,
    maxQty,
    available:    raw.available !== false,
    customFields,
    description:  String(raw.description || '').trim(),
    thumbnail:    raw.thumbnail || null,
  };
}

// ─────────────────────────────────────────
// FIND OR CREATE GROUP
// ✅ الإصلاح الحرجي:
//
// المشكلة: "Last War" يُنشأ كـ root ← أدمن يحرّكه لـ "الألعاب"
//          ← مزامنة تالية لا تجده تحت "الألعاب" ← تُنشئ "Last War" root جديد
//
// الحل: إذا وُجد التصنيف بأي مستوى → حدّث parentId للمستوى الصحيح
//        هذا يضمن عدم التكرار ويحترم هرمية Satofill
// ─────────────────────────────────────────
async function findOrCreateGroup(prisma, name, parentId, sortOrder) {
  // 1. ابحث في المستوى الصحيح أولاً (أسرع)
  let group = null;

  if (parentId === null) {
    group = await prisma.productGroup.findFirst({
      where: { name, parentId: null },
    });
  } else {
    group = await prisma.productGroup.findFirst({
      where: { name, parentId },
    });
  }

  // وجدناه في المستوى الصحيح → استخدمه
  if (group) {
    if (!group.isActive) {
      group = await prisma.productGroup.update({
        where: { id: group.id },
        data:  { isActive: true },
      });
    }
    return group;
  }

  // 2. ابحث بالاسم فقط (قد يكون في مستوى خاطئ)
  const existingGroup = await prisma.productGroup.findFirst({
    where:   { name },
    orderBy: { id: 'asc' },
  });

  if (existingGroup) {
    // ✅ حدّث parentId للمستوى الصحيح — يحل مشكلة التكرار
    group = await prisma.productGroup.update({
      where: { id: existingGroup.id },
      data: {
        parentId:  parentId,
        isActive:  true,
      },
    });

    if (global.logger) {
      global.logger.info(
        '[SATOFILL] Moved group "' + name + '"' +
        ' from parent=' + (existingGroup.parentId || 'root') +
        ' to parent=' + (parentId || 'root')
      );
    }

    return group;
  }

  // 3. لم يوجد أبداً → أنشئه
  group = await prisma.productGroup.create({
    data: {
      name,
      parentId:  parentId,
      isActive:  true,
      sortOrder: sortOrder || 0,
    },
  });

  if (global.logger) {
    global.logger.info(
      '[SATOFILL] Created group "' + name +
      '" (parent=' + (parentId || 'root') + ')'
    );
  }

  return group;
}

// ─────────────────────────────────────────
// SYNC CATEGORIES TO DB
// ✅ يحذف آخر تصنيف فقط عند التطابق التام مع اسم المنتج
//
// مثال صحيح:
//   product="FreeFire B"        categories=["FreeFire B"]
//   → lastCat === pName         → احذف "FreeFire B" → تصنيف: General
//
// مثال محفوظ:
//   product="Last War 500 Gold" categories=["الألعاب", "Last War"]
//   → "last war" ≠ "last war 500 gold"  → احتفظ بالتصنيفات كما هي
//   → الهرمية: الألعاب → Last War → Last War 500 Gold ✅
// ─────────────────────────────────────────
async function syncCategoriesToDB(prisma, categories, productName) {
  let cleaned = (categories || []).map(c => String(c).trim()).filter(Boolean);

  // احذف آخر تصنيف فقط عند التطابق التام
  if (productName && cleaned.length > 0) {
    const lastCat = cleaned[cleaned.length - 1].toLowerCase().trim();
    const pName   = productName.toLowerCase().trim();
    if (lastCat === pName) {
      cleaned = cleaned.slice(0, -1);
      if (global.logger) {
        global.logger.info(
          '[SATOFILL] Removed self-category "' + lastCat +
          '" for product "' + productName + '"'
        );
      }
    }
  }

  // ✅ الإصلاح: إضافة .id لإرجاع Int وليس Object
  if (cleaned.length === 0) {
    const g = await findOrCreateGroup(prisma, 'General', null, 999);
    return g.id;
  }

  let parentId  = null;
  let lastGroup = null;

  for (let i = 0; i < cleaned.length; i++) {
    const group = await findOrCreateGroup(prisma, cleaned[i], parentId, i);
    parentId  = group.id;
    lastGroup = group;
  }

  // ✅ تأكد دائماً من إرجاع Int
  return lastGroup.id;
}

// ─────────────────────────────────────────
// GET ALL PRODUCTS
// ─────────────────────────────────────────
async function getServices() {
  try {
    const data    = await client.get('/products');
    const rawList = extractProducts(data);
    if (global.logger) global.logger.info('[SATOFILL] Raw products: ' + rawList.length);
    if (rawList.length === 0) return [];
    const services = rawList.map(normalizeProduct).filter(Boolean);
    if (global.logger) global.logger.info('[SATOFILL] Normalized: ' + services.length);
    return services;
  } catch (err) {
    if (global.logger) global.logger.error('[SATOFILL] getServices: ' + err.message);
    return [];
  }
}

// ─────────────────────────────────────────
// SYNC PRODUCTS TO DB
// ─────────────────────────────────────────
async function syncProductsToDB(prisma) {
  const services = await getServices();
  if (services.length === 0) return { synced: 0, skipped: 0, errors: 0, total: 0 };

  let synced = 0, skipped = 0, errors = 0;

  for (const svc of services) {
    try {
      if (!svc.serviceId || svc.price < 0) { skipped++; continue; }

      const groupId = await syncCategoriesToDB(prisma, svc.categories, svc.name);

      await prisma.product.upsert({
        where:  { satofillId: svc.serviceId },
        update: {
          name:         svc.name,
          priceUsd:     svc.price,
          minQuantity:  svc.minQty,
          maxQuantity:  svc.maxQty,
          groupId,
          isActive:     svc.available,
          description:  svc.description || null,
          customFields: JSON.stringify(svc.customFields),
          updatedAt:    new Date(),
        },
        create: {
          satofillId:   svc.serviceId,
          name:         svc.name,
          priceUsd:     svc.price,
          minQuantity:  svc.minQty,
          maxQuantity:  svc.maxQty,
          profitMargin: 0.20,
          isManual:     false,
          isActive:     svc.available,
          description:  svc.description || null,
          customFields: JSON.stringify(svc.customFields),
          groupId,
        },
      });
      synced++;
    } catch (e) {
      errors++;
      if (global.logger) {
        global.logger.error('[SATOFILL] Sync error ' + svc.serviceId + ': ' + e.message);
      }
    }
  }

  if (global.logger) {
    global.logger.info(
      '[SATOFILL] Sync done — synced: ' + synced +
      ' skipped: ' + skipped +
      ' errors: ' + errors
    );
  }
  return { synced, skipped, errors, total: services.length };
}

// ─────────────────────────────────────────
// CREATE ORDER
// ─────────────────────────────────────────
async function createOrder(params) {
  const serviceId    = params.serviceId;
  const quantity     = parseInt(params.quantity) || 1;
  let   customFields = params.customFields || {};

  if (Object.keys(customFields).length === 0 && params.link) {
    customFields = { link: params.link, url: params.link };
  }

  const payload = {
    product_id:    parseInt(serviceId),
    quantity,
    custom_fields: customFields,
  };

  if (global.logger) global.logger.info('[SATOFILL] createOrder: ' + JSON.stringify(payload));

  const data = await client.post('/orders', payload);
  if (!data) throw new Error('استجابة فارغة');

  if (data.success === false) {
    const errMsg = (data.error && data.error.message) ? data.error.message
      : (data.error && data.error.code) ? data.error.code
      : data.message || 'فشل إنشاء الطلب';
    throw new Error(errMsg);
  }

  const orderData = data.data || data;
  const orderId   = orderData.order_id || orderData.id;
  if (!orderId) {
    throw new Error('معرّف الطلب مفقود: ' + JSON.stringify(data).substring(0, 200));
  }

  if (global.logger) {
    global.logger.info('[SATOFILL] Order created — id: ' + orderId + ' status: ' + orderData.status);
  }

  return {
    satofillOrderId: String(orderId),
    status:          orderData.status || 'processing',
    newBalance:      orderData.new_balance || null,
    codes:           orderData.codes || [],
  };
}

// ─────────────────────────────────────────
// CHECK ORDER STATUS
// ─────────────────────────────────────────
async function checkOrderStatus(satofillOrderId) {
  const data = await client.get('/orders/' + satofillOrderId);
  if (!data) throw new Error('استجابة فارغة');

  if (data.success === false) {
    const errMsg = (data.error && data.error.message) ? data.error.message : 'فشل التحقق';
    throw new Error(errMsg);
  }

  const orderData = data.data || data;

  if (global.logger) {
    global.logger.info('[SATOFILL] Status #' + satofillOrderId + ' → ' + orderData.status);
  }

  return {
    status:              String(orderData.status || 'processing'),
    orderId:             orderData.order_id    || null,
    productId:           orderData.product_id  || null,
    quantity:            orderData.quantity    || null,
    remains:             orderData.remains     || null,
    startCount:          orderData.start_count || orderData.startCount || null,
    total:               orderData.total       || null,
    codes:               orderData.codes       || [],
    subscriptionDetails: orderData.subscription_details || null,
    createdAt:           orderData.created_at  || null,
  };
}

// ─────────────────────────────────────────
// CHECK MULTIPLE ORDERS
// ─────────────────────────────────────────
async function checkMultipleOrders(satofillOrderIds) {
  if (!satofillOrderIds || satofillOrderIds.length === 0) return {};
  try {
    const ids  = satofillOrderIds.map(id => parseInt(id));
    const data = await client.post('/orders/status', { order_ids: ids });
    if (data && data.data && data.data.orders) return data.data.orders;
    if (data && data.orders) return data.orders;
    return data || {};
  } catch (err) {
    if (global.logger) global.logger.error('[SATOFILL] checkMultipleOrders: ' + err.message);
    return {};
  }
}

// ─────────────────────────────────────────
// GET BALANCE
// ─────────────────────────────────────────
async function getBalance() {
  try {
    const data = await client.get('/balance');
    const bal  = (data && data.data) ? data.data : data;
    return {
      balance:      parseFloat(bal.balance || 0),
      currencyName: bal.currency_name   || 'USD',
      symbol:       bal.currency_symbol || '$',
    };
  } catch (err) {
    if (global.logger) global.logger.error('[SATOFILL] getBalance: ' + err.message);
    return { balance: 0, currencyName: 'USD', symbol: '$' };
  }
}

// ─────────────────────────────────────────
// MAP STATUS
// ─────────────────────────────────────────
function mapStatus(satofillStatus) {
  if (!satofillStatus) return 'PROCESSING';
  const s   = String(satofillStatus).toLowerCase().trim();
  const map = {
    'pending':     'PENDING',
    'processing':  'PROCESSING',
    'in_progress': 'PROCESSING',
    'completed':   'COMPLETED',
    'complete':    'COMPLETED',
    'partial':     'PARTIAL',
    'rejected':    'FAILED',
    'cancelled':   'CANCELLED',
    'canceled':    'CANCELLED',
    'refunded':    'CANCELLED',
    'not_found':   'FAILED',
    'failed':      'FAILED',
    'error':       'FAILED',
  };
  return map[s] || 'PROCESSING';
}

// ─────────────────────────────────────────
// TEST CONNECTION
// ─────────────────────────────────────────
async function testConnection() {
  const start = Date.now();
  try {
    const result = await getBalance();
    return { ok: true, ms: Date.now() - start, endpoint: BASE_URL, balance: result.balance, error: null };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, endpoint: BASE_URL, balance: null, error: err.message };
  }
}

module.exports = {
  getServices,
  syncProductsToDB,
  syncCategoriesToDB,
  findOrCreateGroup,
  createOrder,
  checkOrderStatus,
  checkMultipleOrders,
  getBalance,
  mapStatus,
  testConnection,
};
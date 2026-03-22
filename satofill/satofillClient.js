// satofill/satofillClient.js
const axios  = require('axios');
const config = require('../config/settings');

// ─────────────────────────────────────────
// BASE URL من config (يقرأ من .env)
// ─────────────────────────────────────────
const BASE_URL = config.satofill.apiUrl || 'https://satofill.com/wp-json/mps/v1';

// ─────────────────────────────────────────
// AXIOS CLIENT
// ─────────────────────────────────────────
const client = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  },
});

// ── Request interceptor: إضافة Bearer token ──
client.interceptors.request.use(function (reqConfig) {
  const token = config.satofill.apiKey;
  if (!token || token === 'your_api_token_here') {
    throw new Error('SATOFILL_API_KEY is not configured in .env');
  }
  reqConfig.headers['Authorization'] = 'Bearer ' + token;
  return reqConfig;
});

// ── Response interceptor: معالجة موحدة للأخطاء ──
client.interceptors.response.use(
  function (res) {
    return res.data;
  },
  function (err) {
    const status = err.response ? err.response.status   : null;
    const body   = err.response ? err.response.data     : null;

    let msg = 'Satofill API error';
    if (body && body.error && body.error.message) msg = body.error.message;
    else if (body && body.error && body.error.code) msg = body.error.code;
    else if (body && body.message)                  msg = body.message;
    else if (err.message)                           msg = err.message;

    if (global.logger) {
      global.logger.error('[SATOFILL] HTTP ' + (status || '?') + ': ' + msg);
    }

    if (status === 401) throw new Error('مفتاح API غير صالح (401 Unauthorized)');
    if (status === 403) throw new Error('وصول مرفوض (403): ' + msg);
    if (status === 404) throw new Error('المورد غير موجود (404)');
    if (status === 422) throw new Error('بيانات غير صالحة (422): ' + msg);
    if (status === 429) throw new Error('تم تجاوز حد الطلبات (429)');
    throw new Error(msg);
  }
);

// ─────────────────────────────────────────
// HELPERS — استخراج البيانات من أشكال مختلفة
// ─────────────────────────────────────────

/**
 * استخراج مصفوفة المنتجات من أي شكل للاستجابة
 */
function extractProducts(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;

  // { success: true, data: { products: [...] } }
  if (data.data && data.data.products && Array.isArray(data.data.products)) {
    return data.data.products;
  }
  // { data: [...] }
  if (data.data && Array.isArray(data.data)) return data.data;

  // { products: [...] }
  if (data.products && Array.isArray(data.products)) return data.products;

  // { success: true, data: [...] } مباشرة
  if (data.success && Array.isArray(data.data)) return data.data;

  return [];
}

/**
 * بناء هرمية التصنيفات من مصفوفة categories
 *
 * مثال على الاستجابة من Satofill:
 *   categories: ["الألعاب", "PUBG Mobile", "PUBG Mobile Global"]
 *   → مستوى 0: "الألعاب"       (تصنيف رئيسي، parentId = null)
 *   → مستوى 1: "PUBG Mobile"    (تصنيف فرعي، parent = "الألعاب")
 *   → مستوى 2: "PUBG Mobile Global" (تصنيف فرعي فرعي، parent = "PUBG Mobile")
 *
 * يُرجع: { hierarchy: [{name, level}], leafCategory: "آخر تصنيف" }
 */
function buildCategoryHierarchy(categories) {
  if (!categories || categories.length === 0) {
    return { hierarchy: [{ name: 'General', level: 0 }], leafCategory: 'General' };
  }

  const cleaned = categories
    .map(c => String(c).trim())
    .filter(c => c.length > 0);

  if (cleaned.length === 0) {
    return { hierarchy: [{ name: 'General', level: 0 }], leafCategory: 'General' };
  }

  const hierarchy = cleaned.map((name, index) => ({ name, level: index }));
  const leafCategory = cleaned[cleaned.length - 1];

  return { hierarchy, leafCategory };
}

/**
 * حفظ التصنيفات الهرمية في قاعدة البيانات
 * يُرجع ID آخر تصنيف (الأكثر تفصيلاً)
 */
async function syncCategoriesToDB(prisma, categories) {
  if (!categories || categories.length === 0) {
    // تصنيف افتراضي
    const general = await prisma.productGroup.upsert({
      where:  { name_parentId: { name: 'General', parentId: null } },
      update: { isActive: true },
      create: { name: 'General', parentId: null, isActive: true, sortOrder: 999 },
    });
    return general.id;
  }

  const cleaned = categories
    .map(c => String(c).trim())
    .filter(c => c.length > 0);

  if (cleaned.length === 0) {
    const general = await prisma.productGroup.upsert({
      where:  { name_parentId: { name: 'General', parentId: null } },
      update: { isActive: true },
      create: { name: 'General', parentId: null, isActive: true, sortOrder: 999 },
    });
    return general.id;
  }

  let parentId  = null;
  let lastGroup = null;

  for (let i = 0; i < cleaned.length; i++) {
    const name = cleaned[i];

    // ابحث عن التصنيف بالاسم والأب معاً
    let group = await prisma.productGroup.findFirst({
      where: {
        name:     name,
        parentId: parentId,
      },
    });

    if (!group) {
      group = await prisma.productGroup.create({
        data: {
          name,
          parentId,
          isActive:  true,
          sortOrder: i,
        },
      });
    } else if (!group.isActive) {
      group = await prisma.productGroup.update({
        where: { id: group.id },
        data:  { isActive: true },
      });
    }

    parentId  = group.id;
    lastGroup = group;
  }

  return lastGroup.id;
}

/**
 * تطبيع بيانات منتج واحد من Satofill
 */
function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // استخراج الـ ID
  const serviceId = String(raw.id || raw.service_id || raw.service || '').trim();
  if (!serviceId) return null;

  // استخراج الاسم
  const name = String(raw.name || raw.title || '').trim();
  if (!name) return null;

  // استخراج التصنيفات — مصفوفة هرمية
  let categories = [];
  if (Array.isArray(raw.categories) && raw.categories.length > 0) {
    categories = raw.categories.map(c => String(c).trim()).filter(Boolean);
  } else if (raw.category) {
    categories = [String(raw.category).trim()];
  }

  // استخراج السعر
  const price = parseFloat(raw.price || raw.rate || raw.cost || 0);

  // استخراج الكميات
  const minQty = parseInt(String(raw.min_quantity || raw.min || 1).replace(/\D/g, '')) || 1;
  const maxQty = parseInt(String(raw.max_quantity || raw.max || 100000).replace(/\D/g, '')) || 100000;

  // استخراج الحقول المخصصة (custom_fields) لإنشاء الطلب
  const customFields = Array.isArray(raw.custom_fields) ? raw.custom_fields : [];

  return {
    serviceId,
    name,
    categories,        // مصفوفة هرمية: ["رئيسي", "فرعي", "فرعي فرعي"]
    price,
    minQty,
    maxQty,
    available:    raw.available !== false,
    customFields,
    description:  String(raw.description || '').trim(),
    thumbnail:    raw.thumbnail || raw.image || null,
  };
}

// ─────────────────────────────────────────
// GET ALL PRODUCTS
// GET /products
// ─────────────────────────────────────────
async function getServices() {
  try {
    const data    = await client.get('/products');
    const rawList = extractProducts(data);

    if (global.logger) {
      global.logger.info('[SATOFILL] Raw products count: ' + rawList.length);
    }

    if (rawList.length === 0) return [];

    const services = rawList.map(normalizeProduct).filter(Boolean);

    if (global.logger) {
      global.logger.info('[SATOFILL] Valid products: ' + services.length);
    }

    return services;

  } catch (err) {
    if (global.logger) global.logger.error('[SATOFILL] getServices: ' + err.message);
    return [];
  }
}

// ─────────────────────────────────────────
// GET SINGLE PRODUCT
// GET /products/{id}
// ─────────────────────────────────────────
async function getProduct(productId) {
  try {
    const data = await client.get('/products/' + productId);
    const raw  = data && data.data ? data.data : data;
    return normalizeProduct(raw);
  } catch (err) {
    if (global.logger) global.logger.error('[SATOFILL] getProduct(' + productId + '): ' + err.message);
    return null;
  }
}

// ─────────────────────────────────────────
// SYNC PRODUCTS TO DATABASE
// مزامنة كاملة مع حفظ التصنيفات الهرمية
// ─────────────────────────────────────────
async function syncProductsToDB(prisma) {
  const services = await getServices();
  if (services.length === 0) return { synced: 0, skipped: 0, errors: 0 };

  let synced  = 0;
  let skipped = 0;
  let errors  = 0;

  for (const svc of services) {
    try {
      if (!svc.serviceId || isNaN(svc.price) || svc.price < 0) {
        skipped++;
        continue;
      }

      // حفظ التصنيفات الهرمية والحصول على ID آخر تصنيف
      const groupId = await syncCategoriesToDB(prisma, svc.categories);

      // upsert المنتج
      await prisma.product.upsert({
        where:  { satofillId: svc.serviceId },
        update: {
          name:        svc.name,
          priceUsd:    svc.price,
          minQuantity: svc.minQty,
          maxQuantity: svc.maxQty,
          groupId,
          isActive:    svc.available,
          description: svc.description || null,
          updatedAt:   new Date(),
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
          groupId,
        },
      });

      synced++;

    } catch (svcErr) {
      errors++;
      if (global.logger) {
        global.logger.error('[SATOFILL] syncProductsToDB error for ' + svc.serviceId + ': ' + svcErr.message);
      }
    }
  }

  if (global.logger) {
    global.logger.info('[SATOFILL] Sync done — synced: ' + synced + ', skipped: ' + skipped + ', errors: ' + errors);
  }

  return { synced, skipped, errors, total: services.length };
}

// ─────────────────────────────────────────
// CREATE ORDER
// POST /orders
// ─────────────────────────────────────────
async function createOrder(params) {
  const serviceId    = params.serviceId;
  const quantity     = parseInt(params.quantity) || 1;
  const customFields = params.customFields || {};

  // إذا أُرسل link ولا توجد custom_fields نضعه تلقائياً
  if (params.link && Object.keys(customFields).length === 0) {
    customFields.link = params.link;
    customFields.url  = params.link;
  }

  const payload = {
    product_id:    parseInt(serviceId),
    quantity,
    custom_fields: customFields,
  };

  if (global.logger) {
    global.logger.info('[SATOFILL] createOrder payload: ' + JSON.stringify(payload));
  }

  const data = await client.post('/orders', payload);

  if (!data) throw new Error('استجابة فارغة من Satofill');

  if (data.success === false) {
    let errMsg = 'فشل إنشاء الطلب';
    if (data.error && data.error.message) errMsg = data.error.message;
    else if (data.error && data.error.code) errMsg = data.error.code;
    else if (data.message) errMsg = data.message;
    throw new Error(errMsg);
  }

  const orderData = data.data || data;
  const orderId   = orderData.order_id || orderData.id || orderData.order;

  if (!orderId) {
    throw new Error('معرّف الطلب مفقود في الاستجابة: ' + JSON.stringify(data).substring(0, 200));
  }

  if (global.logger) {
    global.logger.info('[SATOFILL] createOrder success — orderId: ' + orderId);
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
// GET /orders/{id}
// ─────────────────────────────────────────
async function checkOrderStatus(satofillOrderId) {
  const data = await client.get('/orders/' + satofillOrderId);

  if (!data) throw new Error('استجابة فارغة');

  if (data.success === false) {
    const errMsg = (data.error && data.error.message) ? data.error.message : 'فشل التحقق من الطلب';
    throw new Error(errMsg);
  }

  const orderData = data.data || data;

  return {
    status:     String(orderData.status || 'processing'),
    orderId:    orderData.order_id  || null,
    productId:  orderData.product_id || null,
    quantity:   orderData.quantity  || null,
    remains:    orderData.remains   || null,
    startCount: orderData.start_count || orderData.startCount || null,
    total:      orderData.total     || null,
    codes:      orderData.codes     || [],
    createdAt:  orderData.created_at || null,
  };
}

// ─────────────────────────────────────────
// CHECK MULTIPLE ORDERS
// POST /orders/status
// ─────────────────────────────────────────
async function checkMultipleOrders(satofillOrderIds) {
  if (!satofillOrderIds || satofillOrderIds.length === 0) return {};

  try {
    const ids  = satofillOrderIds.map(id => parseInt(id));
    const data = await client.post('/orders/status', { order_ids: ids });

    if (data && data.data && data.data.orders) return data.data.orders;
    if (data && data.orders)                   return data.orders;
    return data || {};

  } catch (err) {
    if (global.logger) global.logger.error('[SATOFILL] checkMultipleOrders: ' + err.message);
    return {};
  }
}

// ─────────────────────────────────────────
// GET BALANCE
// GET /balance
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
// تحويل حالات Satofill إلى حالات النظام
// ─────────────────────────────────────────
function mapStatus(satofillStatus) {
  if (!satofillStatus) return 'PROCESSING';

  const s = String(satofillStatus).toLowerCase().trim();

  const map = {
    'pending':    'PENDING',
    'processing': 'PROCESSING',
    'in_progress': 'PROCESSING',
    'completed':  'COMPLETED',
    'complete':   'COMPLETED',
    'partial':    'PARTIAL',
    'rejected':   'FAILED',
    'cancelled':  'CANCELLED',
    'canceled':   'CANCELLED',
    'refunded':   'CANCELLED',
    'not_found':  'FAILED',
    'failed':     'FAILED',
    'error':      'FAILED',
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
    return {
      ok:       true,
      ms:       Date.now() - start,
      endpoint: BASE_URL,
      balance:  result.balance,
      currency: result.currencyName,
      error:    null,
    };
  } catch (err) {
    return {
      ok:       false,
      ms:       Date.now() - start,
      endpoint: BASE_URL,
      balance:  null,
      error:    err.message,
    };
  }
}

module.exports = {
  getServices,
  getProduct,
  syncProductsToDB,
  syncCategoriesToDB,
  buildCategoryHierarchy,
  createOrder,
  checkOrderStatus,
  checkMultipleOrders,
  getBalance,
  mapStatus,
  testConnection,
};
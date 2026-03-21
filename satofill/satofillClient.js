// satofill/satofillClient.js
const axios  = require('axios');
const config = require('../config/settings');

// ─────────────────────────────────────────
// BASE URL الصحيح من توثيق Satofill
// ─────────────────────────────────────────
const BASE_URL = 'https://satofill.com/wp-json/mps/v1';

// ─────────────────────────────────────────
// AXIOS INSTANCE
// Bearer Token authentication
// ─────────────────────────────────────────
const client = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  },
});

// ─────────────────────────────────────────
// REQUEST INTERCEPTOR — يضيف Bearer Token
// ─────────────────────────────────────────
client.interceptors.request.use((reqConfig) => {
  const token = config.satofill.apiKey;
  if (!token) throw new Error('SATOFILL_API_KEY is not configured');
  reqConfig.headers['Authorization'] = `Bearer ${token}`;
  return reqConfig;
});

// ─────────────────────────────────────────
// RESPONSE INTERCEPTOR
// ─────────────────────────────────────────
client.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const status = err.response?.status;
    const msg    = err.response?.data?.message
                || err.response?.data?.error
                || err.message
                || 'Satofill API error';

    if (global.logger) {
      global.logger.error(`[SATOFILL] HTTP ${status || '?'}: ${msg}`);
    }

    // رسائل خطأ واضحة حسب كود الحالة
    if (status === 401) throw new Error('مفتاح API غير صالح أو منتهي الصلاحية (401)');
    if (status === 403) throw new Error('لا يوجد صلاحية الوصول (403)');
    if (status === 404) throw new Error('المسار غير موجود (404)');
    if (status === 429) throw new Error('تجاوز حد الطلبات، حاول لاحقاً (429)');

    throw new Error(msg);
  }
);

// ─────────────────────────────────────────
// GET ALL PRODUCTS/SERVICES
// GET /wp-json/mps/v1/products
// ─────────────────────────────────────────
async function getServices() {
  try {
    if (!config.satofill.apiKey || config.satofill.apiKey === 'your_satofill_api_key_here') {
      if (global.logger) global.logger.error('[SATOFILL] API key not configured');
      return [];
    }

    const data = await client.get('/products');

    if (global.logger) {
      global.logger.info(
        `[SATOFILL] Products response — type: ${typeof data}, isArray: ${Array.isArray(data)}`
      );
    }

    // معالجة أشكال الاستجابة المحتملة
    let services = [];

    if (Array.isArray(data)) {
      services = data;
    } else if (data && typeof data === 'object') {
      if (data.error || data.message) {
        if (global.logger) global.logger.error(`[SATOFILL] API returned error: ${data.error || data.message}`);
        return [];
      }
      // بعض APIs تغلف البيانات في data أو products أو items
      services = data.data || data.products || data.items || data.result || [];
      if (!Array.isArray(services)) services = Object.values(data);
    }

    // تصفية وتوحيد حقول الخدمات
    const valid = services
      .filter(s => s && typeof s === 'object')
      .map(s => ({
        // نعيّن الحقول بمرونة لأي تسمية تستخدمها Satofill
        service:  String(s.id       ?? s.service    ?? s.service_id ?? '').trim(),
        name:     String(s.name     ?? s.title      ?? s.label      ?? '').trim(),
        category: String(s.category ?? s.type       ?? s.group      ?? 'General').trim(),
        rate:     s.price     ?? s.rate      ?? s.cost       ?? s.price_per_1000 ?? 0,
        min:      s.min       ?? s.min_order ?? s.minimum    ?? 100,
        max:      s.max       ?? s.max_order ?? s.maximum    ?? 100000,
        description: s.description ?? s.desc ?? '',
      }))
      .filter(s => s.service && s.name);

    if (global.logger) {
      global.logger.info(`[SATOFILL] Total: ${services.length}, Valid: ${valid.length}`);
    }

    return valid;

  } catch (err) {
    if (global.logger) global.logger.error(`[SATOFILL] getServices failed: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────
// GET SINGLE PRODUCT
// GET /wp-json/mps/v1/products/:id
// ─────────────────────────────────────────
async function getService(serviceId) {
  try {
    const data = await client.get(`/products/${serviceId}`);
    return data;
  } catch (err) {
    if (global.logger) global.logger.error(`[SATOFILL] getService(${serviceId}) failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────
// CREATE ORDER
// POST /wp-json/mps/v1/orders
// ─────────────────────────────────────────
async function createOrder({ serviceId, quantity, link }) {
  const data = await client.post('/orders', {
    product_id: serviceId,   // أو service_id — نجرب الاثنين
    quantity:   parseInt(quantity),
    link,
  });

  if (!data) throw new Error('Empty response from Satofill');
  if (data.error || data.message?.includes('error')) {
    throw new Error(data.error || data.message);
  }

  // استخراج ID الطلب بمرونة
  const orderId = data.order_id ?? data.id ?? data.order ?? data.data?.id;
  if (!orderId) {
    if (global.logger) {
      global.logger.error(`[SATOFILL] createOrder response: ${JSON.stringify(data)}`);
    }
    throw new Error('Order ID missing from Satofill response');
  }

  return { satofillOrderId: String(orderId) };
}

// ─────────────────────────────────────────
// GET ORDER STATUS (single)
// GET /wp-json/mps/v1/orders/:id
// ─────────────────────────────────────────
async function checkOrderStatus(satofillOrderId) {
  const data = await client.get(`/orders/${satofillOrderId}`);

  if (!data)      throw new Error('Empty response from Satofill');
  if (data.error) throw new Error(data.error);

  return {
    status:     data.status      ?? data.order_status ?? 'Pending',
    startCount: data.start_count != null ? parseInt(data.start_count) : null,
    remains:    data.remains     != null ? parseInt(data.remains)     : null,
    charge:     data.charge      != null ? parseFloat(data.charge)    : null,
    currency:   data.currency    ?? 'USD',
  };
}

// ─────────────────────────────────────────
// MULTIPLE ORDERS STATUS
// POST /wp-json/mps/v1/orders/status
// ─────────────────────────────────────────
async function checkMultipleOrders(satofillOrderIds) {
  if (!satofillOrderIds || satofillOrderIds.length === 0) return {};

  try {
    const data = await client.post('/orders/status', {
      orders: satofillOrderIds,
    });
    return data || {};
  } catch (err) {
    if (global.logger) global.logger.error(`[SATOFILL] checkMultipleOrders: ${err.message}`);
    return {};
  }
}

// ─────────────────────────────────────────
// GET BALANCE
// GET /wp-json/mps/v1/balance
// ─────────────────────────────────────────
async function getBalance() {
  try {
    const data = await client.get('/balance');
    return {
      balance:  parseFloat(data.balance  ?? data.amount ?? 0),
      currency: data.currency ?? 'USD',
    };
  } catch (err) {
    if (global.logger) global.logger.error(`[SATOFILL] getBalance: ${err.message}`);
    return { balance: 0, currency: 'USD' };
  }
}

// ─────────────────────────────────────────
// MAP STATUS
// ─────────────────────────────────────────
function mapStatus(satofillStatus) {
  if (!satofillStatus) return 'PROCESSING';
  const map = {
    'pending':      'PENDING',
    'Pending':      'PENDING',
    'processing':   'PROCESSING',
    'Processing':   'PROCESSING',
    'in progress':  'PROCESSING',
    'In progress':  'PROCESSING',
    'active':       'PROCESSING',
    'Active':       'PROCESSING',
    'completed':    'COMPLETED',
    'Completed':    'COMPLETED',
    'partial':      'PARTIAL',
    'Partial':      'PARTIAL',
    'canceled':     'CANCELLED',
    'Canceled':     'CANCELLED',
    'cancelled':    'CANCELLED',
    'Cancelled':    'CANCELLED',
    'failed':       'FAILED',
    'Failed':       'FAILED',
    'error':        'FAILED',
    'Error':        'FAILED',
  };
  return map[satofillStatus] || 'PROCESSING';
}

// ─────────────────────────────────────────
// TEST CONNECTION — للتشخيص من لوحة الأدمن
// ─────────────────────────────────────────
async function testConnection() {
  const start = Date.now();
  try {
    const balance = await getBalance();
    return {
      ok:       true,
      ms:       Date.now() - start,
      endpoint: BASE_URL,
      balance:  balance.balance,
      currency: balance.currency,
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
  getService,
  createOrder,
  checkOrderStatus,
  checkMultipleOrders,
  getBalance,
  mapStatus,
  testConnection,
};
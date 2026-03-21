const axios  = require('axios');
const config = require('../config/settings');

const BASE_URL = 'https://satofill.com/wp-json/mps/v1';

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  },
});

client.interceptors.request.use(function(reqConfig) {
  var token = config.satofill.apiKey;
  if (!token || token === 'your_satofill_api_key_here') {
    throw new Error('SATOFILL_API_KEY not configured');
  }
  reqConfig.headers['Authorization'] = 'Bearer ' + token;
  return reqConfig;
});

client.interceptors.response.use(
  function(res) { return res.data; },
  function(err) {
    var status = err.response ? err.response.status : null;
    var body   = err.response ? err.response.data   : null;
    var msg    = 'Satofill API error';
    if (body && body.error && body.error.message) msg = body.error.message;
    else if (body && body.error && body.error.code) msg = body.error.code;
    else if (body && body.message) msg = body.message;
    else if (err.message) msg = err.message;

    if (global.logger) {
      global.logger.error('[SATOFILL] HTTP ' + (status || '?') + ': ' + msg);
    }
    if (status === 401) throw new Error('API key invalid (401 Unauthorized)');
    if (status === 403) throw new Error('Access forbidden (403): ' + msg);
    if (status === 404) throw new Error('Not found (404)');
    if (status === 429) throw new Error('Rate limit exceeded (429)');
    throw new Error(msg);
  }
);

// ─────────────────────────────────────────
// EXTRACT PRODUCTS
// البنية: { success, data: { products: [...], total: N } }
// ─────────────────────────────────────────
function extractProducts(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];

  // { success: true, data: { products: [...] } }
  if (data.data && data.data.products && Array.isArray(data.data.products)) {
    return data.data.products;
  }
  // { data: [...] }
  if (data.data && Array.isArray(data.data)) return data.data;
  // { products: [...] }
  if (data.products && Array.isArray(data.products)) return data.products;

  return [];
}

// ─────────────────────────────────────────
// NORMALIZE SERVICE
// ─────────────────────────────────────────
function normalizeService(s) {
  if (!s || typeof s !== 'object') return null;

  var serviceId = s.id || s.service_id || '';
  var name      = s.name || s.title    || '';

  if (!serviceId || !name) return null;

  // categories هي array: ["Games", "Pubg"]
  var category = 'General';
  if (Array.isArray(s.categories) && s.categories.length > 0) {
    category = String(s.categories[0]).trim();
  }

  // custom_fields: حقول مطلوبة لإنشاء الطلب
  var customFields = Array.isArray(s.custom_fields) ? s.custom_fields : [];

  return {
    service:      String(serviceId).trim(),
    name:         String(name).trim(),
    category:     category,
    rate:         parseFloat(s.price || 0),
    min:          parseInt(s.min_quantity || s.min || 1),
    max:          parseInt(s.max_quantity || s.max || 100000),
    available:    s.available !== false,
    customFields: customFields,
    thumbnail:    s.thumbnail || null,
    description:  String(s.description || '').trim(),
  };
}

// ─────────────────────────────────────────
// GET ALL SERVICES
// GET /products
// ─────────────────────────────────────────
async function getServices() {
  try {
    var data = await client.get('/products');

    if (global.logger) {
      var rawStr = JSON.stringify(data) || '';
      global.logger.info('[SATOFILL] Raw (300): ' + rawStr.substring(0, 300));
    }

    var rawList = extractProducts(data);

    if (global.logger) {
      global.logger.info('[SATOFILL] Extracted: ' + rawList.length + ' products');
    }

    if (rawList.length === 0) return [];

    var services = rawList.map(normalizeService).filter(Boolean);

    if (global.logger) {
      global.logger.info('[SATOFILL] Valid: ' + services.length);
    }

    return services;

  } catch (err) {
    if (global.logger) global.logger.error('[SATOFILL] getServices: ' + err.message);
    return [];
  }
}

// ─────────────────────────────────────────
// CREATE ORDER
// POST /orders
// product_id: integer
// quantity: integer
// custom_fields: { key: value }
// ─────────────────────────────────────────
async function createOrder(params) {
  var serviceId    = params.serviceId;
  var quantity     = params.quantity;
  var customFields = params.customFields || {};

  // إذا أُرسل link نضعه في custom_fields تلقائياً
  if (params.link && Object.keys(customFields).length === 0) {
    customFields = { link: params.link, url: params.link };
  }

  var payload = {
    product_id:    parseInt(serviceId),
    quantity:      parseInt(quantity) || 1,
    custom_fields: customFields,
  };

  if (global.logger) {
    global.logger.info('[SATOFILL] createOrder payload: ' + JSON.stringify(payload));
  }

  var data = await client.post('/orders', payload);

  if (global.logger) {
    global.logger.info('[SATOFILL] createOrder response: ' + JSON.stringify(data).substring(0, 300));
  }

  // الرد: { success: true, data: { order_id, status, ... } }
  if (!data) throw new Error('Empty response from Satofill');

  if (data.success === false) {
    var errMsg = 'Order failed';
    if (data.error && data.error.message) errMsg = data.error.message;
    else if (data.error && data.error.code)  errMsg = data.error.code;
    throw new Error(errMsg);
  }

  var orderData = data.data || data;
  var orderId   = orderData.order_id || orderData.id || orderData.order;

  if (!orderId) {
    throw new Error('Order ID missing. Response: ' + JSON.stringify(data).substring(0, 200));
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
// Statuses: processing, completed, rejected, cancelled, pending
// ─────────────────────────────────────────
async function checkOrderStatus(satofillOrderId) {
  var data = await client.get('/orders/' + satofillOrderId);

  if (!data) throw new Error('Empty response');

  if (data.success === false) {
    var errMsg = 'Status check failed';
    if (data.error && data.error.message) errMsg = data.error.message;
    throw new Error(errMsg);
  }

  var orderData = (data.data) ? data.data : data;

  return {
    status:              String(orderData.status || 'processing'),
    orderId:             orderData.order_id    || null,
    productId:           orderData.product_id  || null,
    quantity:            orderData.quantity    || null,
    total:               orderData.total       || null,
    codes:               orderData.codes       || [],
    subscriptionDetails: orderData.subscription_details || null,
    createdAt:           orderData.created_at  || null,
  };
}

// ─────────────────────────────────────────
// CHECK MULTIPLE ORDERS
// POST /orders/status
// Body: { order_ids: [id1, id2, ...] }  ← order_ids وليس orders
// ─────────────────────────────────────────
async function checkMultipleOrders(satofillOrderIds) {
  if (!satofillOrderIds || satofillOrderIds.length === 0) return {};
  try {
    var ids  = satofillOrderIds.map(function(id) { return parseInt(id); });
    var data = await client.post('/orders/status', { order_ids: ids });

    if (data && data.data && data.data.orders) {
      return data.data.orders;
    }
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
    var data = await client.get('/balance');
    var bal  = (data && data.data) ? data.data : data;
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
// القيم الفعلية من Satofill:
// processing, completed, rejected, cancelled, pending
// ─────────────────────────────────────────
function mapStatus(satofillStatus) {
  if (!satofillStatus) return 'PROCESSING';

  var s = String(satofillStatus).toLowerCase().trim();

  var map = {
    'pending':    'PENDING',
    'processing': 'PROCESSING',
    'completed':  'COMPLETED',
    'complete':   'COMPLETED',
    'rejected':   'FAILED',      // ← الحالة الحرجة المفقودة سابقاً
    'cancelled':  'CANCELLED',
    'canceled':   'CANCELLED',
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
  var start = Date.now();
  try {
    var result = await getBalance();
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
  createOrder,
  checkOrderStatus,
  checkMultipleOrders,
  getBalance,
  mapStatus,
  testConnection,
};
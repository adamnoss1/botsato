const axios  = require('axios');
const config = require('../config/settings');

// ─────────────────────────────────────────
// AXIOS INSTANCE
// ─────────────────────────────────────────
const client = axios.create({
  baseURL: config.satofill.apiUrl,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// ─────────────────────────────────────────
// REQUEST INTERCEPTOR
// ─────────────────────────────────────────
client.interceptors.request.use((reqConfig) => {
  reqConfig.params = {
    ...reqConfig.params,
    key: config.satofill.apiKey,
  };
  return reqConfig;
});

// ─────────────────────────────────────────
// RESPONSE INTERCEPTOR
// ─────────────────────────────────────────
client.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const msg = err.response?.data?.error || err.message || 'Satofill API error';
    if (global.logger) global.logger.error(`[SATOFILL] ${msg}`);
    throw new Error(msg);
  }
);

// ─────────────────────────────────────────
// GET ALL SERVICES
// ─────────────────────────────────────────
async function getServices() {
  try {
    const data = await client.get('', {
      params: { action: 'services' },
    });

    // API قد يُرجع array مباشرة أو object
    let services = [];
    if (Array.isArray(data)) {
      services = data;
    } else if (data && typeof data === 'object') {
      // بعض APIs تُرجع { data: [...] } أو { services: [...] }
      services = data.data || data.services || Object.values(data);
    }

    // تصفية العناصر الصالحة فقط
    return services.filter(s =>
      s &&
      typeof s === 'object' &&
      (s.service || s.id) &&
      (s.name || s.title)
    );
  } catch (err) {
    if (global.logger) global.logger.error(`[SATOFILL] getServices: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────
// CREATE ORDER
// ─────────────────────────────────────────
async function createOrder({ serviceId, quantity, link }) {
  const data = await client.post('', null, {
    params: {
      action:   'add',
      service:  serviceId,
      quantity: quantity,
      link:     link,
    },
  });

  if (!data || !data.order) {
    throw new Error(data?.error || 'Failed to create order on Satofill');
  }

  return { satofillOrderId: String(data.order) };
}

// ─────────────────────────────────────────
// CHECK ORDER STATUS
// ─────────────────────────────────────────
async function checkOrderStatus(satofillOrderId) {
  const data = await client.post('', null, {
    params: {
      action: 'status',
      order:  satofillOrderId,
    },
  });

  if (!data) throw new Error('Empty response from Satofill');

  return {
    status:     data.status      || 'Pending',
    startCount: data.start_count ? parseInt(data.start_count) : null,
    remains:    data.remains     ? parseInt(data.remains)     : null,
    charge:     data.charge      ? parseFloat(data.charge)    : null,
    currency:   data.currency    || 'USD',
  };
}

// ─────────────────────────────────────────
// CHECK MULTIPLE ORDERS
// ─────────────────────────────────────────
async function checkMultipleOrders(satofillOrderIds) {
  if (!satofillOrderIds || satofillOrderIds.length === 0) return {};

  try {
    const data = await client.post('', null, {
      params: {
        action: 'status',
        orders: satofillOrderIds.join(','),
      },
    });
    return data || {};
  } catch (err) {
    if (global.logger) global.logger.error(`[SATOFILL] checkMultipleOrders: ${err.message}`);
    return {};
  }
}

// ─────────────────────────────────────────
// MAP STATUS
// ─────────────────────────────────────────
function mapStatus(satofillStatus) {
  const map = {
    'Pending':     'PENDING',
    'Processing':  'PROCESSING',
    'In progress': 'PROCESSING',
    'Completed':   'COMPLETED',
    'Partial':     'PARTIAL',
    'Canceled':    'CANCELLED',
    'Cancelled':   'CANCELLED',
    'Failed':      'FAILED',
  };
  return map[satofillStatus] || 'PROCESSING';
}

module.exports = {
  getServices,
  createOrder,
  checkOrderStatus,
  checkMultipleOrders,
  mapStatus,
};
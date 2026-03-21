// jobs/cacheRefresh.js  ← ملف جديد يجب إنشاؤه
const cron = require('node-cron');
const { refreshProductCache } = require('../services/orderService');

let isRunning = false;

// ─────────────────────────────────────────
// REFRESH SATOFILL PRODUCT CACHE
// Every 30 seconds
// ─────────────────────────────────────────
cron.schedule('*/30 * * * * *', async () => {
  if (isRunning) return; // تجنب التشغيل المتزامن
  isRunning = true;

  try {
    const products = await refreshProductCache();
    if (global.logger && products.length > 0) {
      global.logger.info(`[JOB:cacheRefresh] Cache updated: ${products.length} services`);
    }
  } catch (err) {
    if (global.logger) global.logger.error(`[JOB:cacheRefresh] ${err.message}`);
  } finally {
    isRunning = false;
  }
});

if (global.logger) global.logger.info('✅ Job registered: cacheRefresh (every 30 sec)');
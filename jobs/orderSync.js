const cron   = require('node-cron');
const { syncOrderStatuses } = require('../services/orderService');

// ─────────────────────────────────────────
// SYNC SATOFILL ORDER STATUSES
// Every 1 minute
// ─────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    const synced = await syncOrderStatuses();
    if (synced > 0 && global.logger) {
      global.logger.info(`[JOB:orderSync] Synced ${synced} orders`);
    }
  } catch (err) {
    if (global.logger) global.logger.error(`[JOB:orderSync] ${err.message}`);
  }
});

if (global.logger) global.logger.info('✅ Job registered: orderSync (every 1 min)');
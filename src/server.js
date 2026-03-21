require('dotenv').config();

const http   = require('http');
const config = require('../config/settings');

const winston = require('winston');
const logger  = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(function(info) {
      return '[' + info.timestamp + '] ' + info.level.toUpperCase() + ': ' + info.message;
    })
  ),
  transports: [new winston.transports.Console()],
});
global.logger = logger;

var appReady   = false;
var expressApp = null;
var PORT       = parseInt(process.env.PORT) || 3000;

var rawServer = http.createServer(function(req, res) {
  if (req.url === '/health' || req.url === '/health/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ready: appReady, uptime: process.uptime() }));
    return;
  }
  if (expressApp) {
    expressApp(req, res);
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'starting' }));
  }
});

rawServer.listen(PORT, '0.0.0.0', function() {
  logger.info('HTTP server on port ' + PORT);
  initialize();
});

rawServer.on('error', function(err) {
  console.error('Server error: ' + err.message);
  process.exit(1);
});

function pushSchema() {
  return new Promise(function(resolve) {
    var exec = require('child_process').exec;
    logger.info('Pushing schema...');
    exec('npx prisma db push --accept-data-loss --skip-generate', { timeout: 120000 },
      function(error, stdout) {
        if (error) { logger.error('Schema push failed: ' + error.message); }
        else if (stdout) { logger.info(stdout.trim()); }
        logger.info('Schema done');
        resolve();
      }
    );
  });
}

async function ensureAdmin(prisma) {
  var bcrypt   = require('bcryptjs');
  var existing = await prisma.admin.findFirst({ where: { username: config.admin.username } });
  if (!existing) {
    var hash = await bcrypt.hash(config.admin.password, 12);
    await prisma.admin.create({
      data: { username: config.admin.username, passwordHash: hash, isSuperAdmin: true, isActive: true },
    });
    logger.info('Admin created');
  } else {
    logger.info('Admin exists');
  }
}

async function ensureSettings(prisma) {
  var defaults = [
    ['exchange_rate', String(config.pricing.exchangeRate)],
    ['profit_margin', String(config.pricing.profitMargin)],
    ['maintenance_mode', 'false'],
    ['channel_verification', 'false'],
    ['referral_commission', '0.05'],
    ['min_deposit', '10'], ['max_deposit', '10000'],
    ['min_withdraw', '10'], ['max_withdraw', '5000'],
    ['vip_bronze_threshold', '100'], ['vip_silver_threshold', '500'], ['vip_gold_threshold', '2000'],
    ['vip_bronze_discount', '0.02'], ['vip_silver_discount', '0.05'], ['vip_gold_discount', '0.10'],
    ['support_min_length', '20'], ['bot_name', 'Bot'], ['welcome_message', 'مرحباً!'],
  ];
  for (var i = 0; i < defaults.length; i++) {
    await prisma.setting.upsert({
      where: { key: defaults[i][0] }, update: {}, create: { key: defaults[i][0], value: defaults[i][1] },
    });
  }
  logger.info('Settings ready');
}

// ─────────────────────────────────────────
// JOBS — مستقلة تماماً عن initialize
// ─────────────────────────────────────────
function startJobs() {
  logger.info('=== STARTING JOBS ===');

  // ── orderSync ──
  try {
    var cron     = require('node-cron');
    var PrismaC  = require('@prisma/client').PrismaClient;
    var satofill = require('../satofill/satofillClient');
    var jobPrisma = new PrismaC({ log: [] });

    var syncRunning = false;

    async function runOrderSync() {
      if (syncRunning) { return; }
      syncRunning = true;
      try {
        var orders = await jobPrisma.order.findMany({
          where: { status: { in: ['PENDING', 'PROCESSING'] } },
          take: 50,
          orderBy: { createdAt: 'desc' },
        });

        logger.info('[SYNC] Active orders: ' + orders.length);
        if (orders.length === 0) { syncRunning = false; return; }

        for (var i = 0; i < orders.length; i++) {
          var order = orders[i];
          if (!order.satofillOrderId) {
            logger.info('[SYNC] Order #' + order.id + ' no satofillId — skip');
            continue;
          }

          try {
            logger.info('[SYNC] Checking #' + order.id + ' → ' + order.satofillOrderId);

            var result    = await satofill.checkOrderStatus(order.satofillOrderId);
            var newStatus = satofill.mapStatus(result.status);

            logger.info('[SYNC] #' + order.id + ' satofill="' + result.status + '" mapped="' + newStatus + '" was="' + order.status + '"');

            if (newStatus === order.status) { continue; }

            logger.info('[SYNC] #' + order.id + ' CHANGING: ' + order.status + ' -> ' + newStatus);

            if (newStatus === 'FAILED' || newStatus === 'CANCELLED') {
              var refundAmt = parseFloat(order.totalPrice);
              await jobPrisma.$transaction(async function(tx) {
                await tx.order.update({
                  where: { id: order.id },
                  data: { status: newStatus, adminNote: 'Satofill: ' + result.status + ' — refunded', updatedAt: new Date() },
                });
                var user = await tx.user.findUnique({ where: { id: order.userId } });
                if (!user) return;
                var before = parseFloat(user.balance);
                var after  = before + refundAmt;
                await tx.user.update({ where: { id: order.userId }, data: { balance: after } });
                await tx.walletTransaction.create({
                  data: {
                    userId: order.userId, type: 'REFUND',
                    amount: refundAmt, balanceBefore: before, balanceAfter: after,
                    description: 'استرداد — طلب #' + order.id + ' (' + newStatus + ')',
                    refId: String(order.id),
                  },
                });
              });
              logger.info('[SYNC] Refunded ' + refundAmt + '$ to user #' + order.userId);

              try {
                var bot  = require('../bot/bot').bot;
                var u    = await jobPrisma.user.findUnique({ where: { id: order.userId } });
                if (bot && u) {
                  var emoji = newStatus === 'CANCELLED' ? '🚫' : '❌';
                  var label = newStatus === 'CANCELLED' ? 'ملغى' : 'مرفوض';
                  await bot.telegram.sendMessage(Number(u.telegramId),
                    emoji + ' تحديث طلب #' + order.id + '\nالحالة: ' + label +
                    '\nتم إعادة ' + refundAmt.toFixed(2) + '$ لرصيدك.'
                  );
                }
              } catch (_) {}

            } else if (newStatus === 'PARTIAL') {
              var remains  = parseInt(result.remains) || 0;
              var ppu      = parseFloat(order.pricePerUnit) || 0;
              var partialR = remains > 0 ? parseFloat((ppu * remains).toFixed(4)) : 0;
              await jobPrisma.$transaction(async function(tx) {
                await tx.order.update({
                  where: { id: order.id },
                  data: { status: 'PARTIAL', remains: remains, startCount: result.startCount || null, updatedAt: new Date() },
                });
                if (partialR > 0) {
                  var u2 = await tx.user.findUnique({ where: { id: order.userId } });
                  if (!u2) return;
                  var b2 = parseFloat(u2.balance);
                  var a2 = b2 + partialR;
                  await tx.user.update({ where: { id: order.userId }, data: { balance: a2 } });
                  await tx.walletTransaction.create({
                    data: {
                      userId: order.userId, type: 'REFUND',
                      amount: partialR, balanceBefore: b2, balanceAfter: a2,
                      description: 'استرداد جزئي — طلب #' + order.id,
                      refId: String(order.id),
                    },
                  });
                }
              });
              logger.info('[SYNC] Partial refund ' + partialR + '$ for order #' + order.id);

            } else if (newStatus === 'COMPLETED') {
              await jobPrisma.order.update({
                where: { id: order.id },
                data: { status: 'COMPLETED', startCount: result.startCount || null, remains: 0, updatedAt: new Date() },
              });
              try {
                var botC = require('../bot/bot').bot;
                var uC   = await jobPrisma.user.findUnique({ where: { id: order.userId } });
                if (botC && uC) {
                  await botC.telegram.sendMessage(Number(uC.telegramId), '✅ تم إكمال طلبك #' + order.id + ' بنجاح!');
                }
              } catch (_) {}

            } else {
              await jobPrisma.order.update({
                where: { id: order.id },
                data: { status: newStatus, startCount: result.startCount || null, remains: result.remains || null, updatedAt: new Date() },
              });
            }

          } catch (orderErr) {
            logger.error('[SYNC] Order #' + order.id + ' error: ' + orderErr.message);
          }
        }

      } catch (syncErr) {
        logger.error('[SYNC] Error: ' + syncErr.message);
      } finally {
        syncRunning = false;
      }
    }

    cron.schedule('* * * * *', function() { runOrderSync(); });
    logger.info('[SYNC] Job registered — every 1 min');

  } catch (e) {
    logger.error('orderSync setup failed: ' + e.message);
    logger.error(e.stack || '');
  }

  // ── cacheRefresh ──
  try {
    var cron2         = require('node-cron');
    var orderSvcCache = require('../services/orderService');
    var cacheRunning  = false;
    cron2.schedule('*/30 * * * * *', async function() {
      if (cacheRunning) return;
      cacheRunning = true;
      try { await orderSvcCache.refreshProductCache(); }
      catch (_) {}
      finally { cacheRunning = false; }
    });
    logger.info('[CACHE] Job registered — every 30s');
  } catch (e) {
    logger.error('cacheRefresh setup failed: ' + e.message);
  }

  // ── dailyStats ──
  try {
    require('../jobs/dailyStats');
    logger.info('[STATS] Job registered');
  } catch (e) {
    logger.error('dailyStats setup failed: ' + e.message);
  }

  // ── backupJob ──
  try {
    require('../jobs/backupJob');
    logger.info('[BACKUP] Job registered');
  } catch (e) {
    logger.error('backupJob setup failed: ' + e.message);
  }

  logger.info('=== ALL JOBS LOADED ===');
}

// ─────────────────────────────────────────
// MAIN INITIALIZATION
// ─────────────────────────────────────────
async function initialize() {
  try {
    await pushSchema();

    var PrismaClient = require('@prisma/client').PrismaClient;
    var prisma = new PrismaClient({ log: ['error'] });
    await prisma.$connect();
    logger.info('Database connected');

    await ensureAdmin(prisma);
    await ensureSettings(prisma);

    logger.info('Loading Express...');
    expressApp = require('./app');
    logger.info('Express loaded');

    try {
      var startBot = require('../bot/bot').startBot;
      await startBot();
      logger.info('Bot started');
    } catch (botErr) {
      logger.error('Bot error (non-fatal): ' + botErr.message);
    }

    // Jobs تعمل بشكل مستقل — لا تؤثر على التهيئة
    startJobs();

    appReady = true;
    logger.info('=== APPLICATION READY ===');

  } catch (err) {
    logger.error('Initialization failed: ' + err.message);
    logger.error(err.stack || '');
  }
}

process.on('SIGTERM', function() {
  logger.info('SIGTERM');
  rawServer.close(function() { process.exit(0); });
});

process.on('SIGINT', function() {
  logger.info('SIGINT');
  rawServer.close(function() { process.exit(0); });
});

process.on('unhandledRejection', function(reason) {
  logger.error('UnhandledRejection: ' + String(reason && reason.message ? reason.message : reason));
});

process.on('uncaughtException', function(err) {
  logger.error('UncaughtException: ' + err.message);
});
```

---

بعد الرفع ستظهر هذه الأسطر بالترتيب في الـ logs:
```
HTTP server on port XXXX
Pushing schema...
Database connected
Admin exists
Settings ready
Loading Express...
Express loaded
Bot started
=== STARTING JOBS ===
[SYNC] Job registered — every 1 min
[CACHE] Job registered — every 30s
[STATS] Job registered
[BACKUP] Job registered
=== ALL JOBS LOADED ===
=== APPLICATION READY ===
```

وبعد دقيقة:
```
[SYNC] Active orders: 1
[SYNC] Checking #6 → 285925
[SYNC] #6 satofill="rejected" mapped="FAILED" was="PROCESSING"
[SYNC] #6 CHANGING: PROCESSING -> FAILED
[SYNC] Refunded 4.41$ to user #X
// src/server.js
require('dotenv').config();

const http   = require('http');
const config = require('../config/settings');
const winston = require('winston');

// ─────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(function (info) {
      return '[' + info.timestamp + '] ' + info.level.toUpperCase() + ': ' + info.message;
    })
  ),
  transports: [new winston.transports.Console()],
});
global.logger = logger;

// ─────────────────────────────────────────
// HTTP SERVER (يبدأ فوراً لاستقبال health checks)
// ─────────────────────────────────────────
let appReady   = false;
let expressApp = null;
const PORT     = parseInt(process.env.PORT) || 3000;

const rawServer = http.createServer(function (req, res) {
  // Health check يعمل دائماً حتى قبل اكتمال التهيئة
  if (req.url === '/health' || req.url === '/health/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: appReady ? 'ok' : 'starting',
      ready:  appReady,
      uptime: process.uptime(),
    }));
    return;
  }

  if (expressApp) {
    expressApp(req, res);
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'starting', message: 'Server is initializing...' }));
  }
});

rawServer.listen(PORT, '0.0.0.0', function () {
  logger.info('HTTP server listening on port ' + PORT);
  initialize();
});

rawServer.on('error', function (err) {
  logger.error('Server error: ' + err.message);
  process.exit(1);
});

// ─────────────────────────────────────────
// ENSURE DEFAULT ADMIN EXISTS
// ─────────────────────────────────────────
async function ensureAdmin(prisma) {
  const bcrypt   = require('bcryptjs');
  const existing = await prisma.admin.findFirst({
    where: { username: config.admin.username },
  });

  if (!existing) {
    const hash = await bcrypt.hash(config.admin.password, 12);
    await prisma.admin.create({
      data: {
        username:     config.admin.username,
        passwordHash: hash,
        isSuperAdmin: true,
        isActive:     true,
      },
    });
    logger.info('Default admin created: ' + config.admin.username);
  } else {
    logger.info('Admin exists: ' + config.admin.username);
  }
}

// ─────────────────────────────────────────
// ENSURE DEFAULT SETTINGS EXIST
// ─────────────────────────────────────────
async function ensureSettings(prisma) {
  const defaults = [
    ['exchange_rate',          String(config.pricing.exchangeRate)],
    ['profit_margin',          String(config.pricing.profitMargin)],
    ['maintenance_mode',       'false'],
    ['channel_verification',   'false'],
    ['referral_commission',    '0.05'],
    ['min_deposit',            '10'],
    ['max_deposit',            '10000'],
    ['min_withdraw',           '10'],
    ['max_withdraw',           '5000'],
    ['vip_bronze_threshold',   '100'],
    ['vip_silver_threshold',   '500'],
    ['vip_gold_threshold',     '2000'],
    ['vip_bronze_discount',    '0.02'],
    ['vip_silver_discount',    '0.05'],
    ['vip_gold_discount',      '0.10'],
    ['support_min_length',     '20'],
    ['bot_name',               'Bot'],
    ['welcome_message',        'مرحباً بك! 👋'],
  ];

  for (const [key, value] of defaults) {
    await prisma.setting.upsert({
      where:  { key },
      update: {},
      create: { key, value },
    });
  }

  logger.info('Default settings verified');
}

// ─────────────────────────────────────────
// START BACKGROUND JOBS
// كل job في ملفه المستقل
// ─────────────────────────────────────────
function startJobs() {
  logger.info('=== STARTING BACKGROUND JOBS ===');

  const jobs = [
    { name: 'orderSync',     path: '../jobs/orderSync'     },
    { name: 'cacheRefresh',  path: '../jobs/cacheRefresh'  },
    { name: 'dailyStats',    path: '../jobs/dailyStats'    },
    { name: 'backupJob',     path: '../jobs/backupJob'     },
  ];

  for (const job of jobs) {
    try {
      require(job.path);
      logger.info('[JOB] Loaded: ' + job.name);
    } catch (err) {
      logger.error('[JOB] Failed to load ' + job.name + ': ' + err.message);
    }
  }

  logger.info('=== ALL JOBS LOADED ===');
}

// ─────────────────────────────────────────
// MAIN INITIALIZATION
// ─────────────────────────────────────────
async function initialize() {
  try {
    // 1. اتصال قاعدة البيانات
    logger.info('Connecting to database...');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient({ log: ['error'] });
    await prisma.$connect();
    logger.info('Database connected');

    // 2. إعداد البيانات الأساسية
    await ensureAdmin(prisma);
    await ensureSettings(prisma);
    await prisma.$disconnect();

    // 3. تحميل Express
    logger.info('Loading Express app...');
    expressApp = require('./app');
    logger.info('Express app loaded');

    // 4. تشغيل البوت
    try {
      const { startBot } = require('../bot/bot');
      await startBot();
      logger.info('Telegram bot started');
    } catch (botErr) {
      // البوت اختياري — لا يوقف التطبيق
      logger.error('Bot failed to start (non-fatal): ' + botErr.message);
    }

    // 5. تشغيل الـ Jobs
    startJobs();

    // 6. التطبيق جاهز
    appReady = true;
    logger.info('=== APPLICATION READY on port ' + PORT + ' ===');

  } catch (err) {
    logger.error('Initialization failed: ' + err.message);
    logger.error(err.stack || '');
    // لا نخرج — نترك health check يعمل ونحاول مجدداً بعد 10 ثواني
    setTimeout(initialize, 10000);
  }
}

// ─────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────
process.once('SIGTERM', function () {
  logger.info('SIGTERM received — shutting down gracefully');
  rawServer.close(function () {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.once('SIGINT', function () {
  logger.info('SIGINT received');
  rawServer.close(function () { process.exit(0); });
});

// ─────────────────────────────────────────
// GLOBAL ERROR HANDLERS
// ─────────────────────────────────────────
process.on('unhandledRejection', function (reason) {
  const msg = reason && reason.message ? reason.message : String(reason);
  logger.error('UnhandledRejection: ' + msg);
});

process.on('uncaughtException', function (err) {
  logger.error('UncaughtException: ' + err.message);
  logger.error(err.stack || '');
});
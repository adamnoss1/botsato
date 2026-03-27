// src/server.js
require('dotenv').config();

const http    = require('http');
const config  = require('../config/settings');
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
// HTTP SERVER
// ─────────────────────────────────────────
let appReady   = false;
let expressApp = null;
const PORT     = parseInt(process.env.PORT) || 3000;

const rawServer = http.createServer(function (req, res) {
  if (req.url === '/health' || req.url === '/health/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: appReady ? 'ok' : 'starting', ready: appReady, uptime: process.uptime() }));
    return;
  }
  if (expressApp) {
    expressApp(req, res);
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'starting' }));
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
// ENSURE ADMIN
// ─────────────────────────────────────────
async function ensureAdmin(prisma) {
  const bcrypt   = require('bcryptjs');
  const existing = await prisma.admin.findFirst({ where: { username: config.admin.username } });
  if (!existing) {
    const hash = await bcrypt.hash(config.admin.password, 12);
    await prisma.admin.create({
      data: { username: config.admin.username, passwordHash: hash, isSuperAdmin: true, isActive: true },
    });
    logger.info('Default admin created: ' + config.admin.username);
  } else {
    logger.info('Admin exists: ' + config.admin.username);
  }
}

// ─────────────────────────────────────────
// ENSURE SETTINGS
// ─────────────────────────────────────────
async function ensureSettings(prisma) {
  const defaults = [
    ['exchange_rate', String(config.pricing.exchangeRate)],
    ['profit_margin', String(config.pricing.profitMargin)],
    ['maintenance_mode', 'false'],
    ['channel_verification', 'false'],
    ['referral_commission', '0.05'],
    ['min_deposit', '10'], ['max_deposit', '10000'],
    ['min_withdraw', '10'], ['max_withdraw', '5000'],
    ['vip_bronze_threshold', '100'], ['vip_silver_threshold', '500'], ['vip_gold_threshold', '2000'],
    ['vip_bronze_discount', '0.02'], ['vip_silver_discount', '0.05'], ['vip_gold_discount', '0.10'],
    ['support_min_length', '20'], ['bot_name', 'Bot'], ['welcome_message', 'مرحباً بك! 👋'],
  ];
  for (const [key, value] of defaults) {
    await prisma.setting.upsert({ where: { key }, update: {}, create: { key, value } });
  }
  logger.info('Default settings verified');
}

// ─────────────────────────────────────────
// START JOBS — مستقلة تماماً
// ─────────────────────────────────────────
function startJobs() {
  logger.info('=== STARTING BACKGROUND JOBS ===');

  const jobs = [
    { name: 'orderSync',    path: '../jobs/orderSync'    },
    { name: 'cacheRefresh', path: '../jobs/cacheRefresh' },
    { name: 'dailyStats',   path: '../jobs/dailyStats'   },
    { name: 'backupJob',    path: '../jobs/backupJob'     },
  ];

  for (const job of jobs) {
    try {
      require(job.path);
      logger.info('[JOB] Loaded: ' + job.name);
    } catch (err) {
      logger.error('[JOB] FAILED to load ' + job.name + ': ' + err.message);
      logger.error(err.stack || '');
    }
  }

  logger.info('=== ALL JOBS LOADED ===');
}

// ─────────────────────────────────────────
// MAIN INITIALIZATION
// ─────────────────────────────────────────
async function initialize() {
  try {
    logger.info('Connecting to database...');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient({ log: ['error'] });
    await prisma.$connect();
    logger.info('Database connected');

    await ensureAdmin(prisma);
    await ensureSettings(prisma);
    await prisma.$disconnect();

    logger.info('Loading Express app...');
    expressApp = require('./app');
    logger.info('Express app loaded');

    // ── تشغيل الـ Jobs أولاً — لا ننتظر البوت ──
    startJobs();

    // ── تشغيل البوت بعد Jobs ──
    try {
      const { startBot } = require('../bot/bot');
      await startBot();
      logger.info('Telegram bot started');
    } catch (botErr) {
      logger.error('Bot failed (non-fatal): ' + botErr.message);
    }

    appReady = true;
    logger.info('=== APPLICATION READY on port ' + PORT + ' ===');

  } catch (err) {
    logger.error('Initialization failed: ' + err.message);
    logger.error(err.stack || '');
    setTimeout(initialize, 10000);
  }
}

// ─────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────
process.once('SIGTERM', function () {
  logger.info('SIGTERM received');
  rawServer.close(function () { process.exit(0); });
});

process.once('SIGINT', function () {
  logger.info('SIGINT received');
  rawServer.close(function () { process.exit(0); });
});

process.on('unhandledRejection', function (reason) {
  const msg = reason && reason.message ? reason.message : String(reason);
  logger.error('UnhandledRejection: ' + msg);
});

process.on('uncaughtException', function (err) {
  logger.error('UncaughtException: ' + err.message);
  logger.error(err.stack || '');
});
require('dotenv').config();

const http   = require('http');
const config = require('../config/settings');

// ─────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────
const winston = require('winston');
const logger  = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});
global.logger = logger;

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
let appReady   = false;
let expressApp = null;
const PORT     = config.app.port;

// ─────────────────────────────────────────
// STEP 1: RAW HTTP SERVER - يبدأ فوراً
// ─────────────────────────────────────────
const rawServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/health/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:    'ok',
      ready:     appReady,
      timestamp: new Date().toISOString(),
      uptime:    process.uptime(),
    }));
    return;
  }

  if (expressApp) {
    expressApp(req, res);
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:  'starting',
      message: 'Application is initializing...',
    }));
  }
});

rawServer.listen(PORT, '0.0.0.0', () => {
  logger.info(`✅ HTTP server listening on port ${PORT}`);
  logger.info('🔄 Starting background initialization...');

  initialize().catch((err) => {
    logger.error(`❌ Fatal: ${err.message}`);
    process.exit(1);
  });
});

// ─────────────────────────────────────────
// PUSH SCHEMA TO DATABASE (بدلاً من migrate)
// ─────────────────────────────────────────
async function pushSchema() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    logger.info('🔄 Pushing schema to database (prisma db push)...');
    exec(
      'npx prisma db push --accept-data-loss --skip-generate',
      { timeout: 120000 },
      (error, stdout, stderr) => {
        if (error) {
          logger.error(`⚠️ Schema push error: ${error.message}`);
          if (stderr) logger.error(`[STDERR] ${stderr.trim()}`);
          resolve(); // لا نوقف التشغيل
          return;
        }
        if (stdout) logger.info(`[DB PUSH] ${stdout.trim()}`);
        logger.info('✅ Schema pushed successfully - all tables created');
        resolve();
      }
    );
  });
}

// ─────────────────────────────────────────
// ENSURE ADMIN EXISTS
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
    logger.info(`✅ Default admin created: ${config.admin.username}`);
  } else {
    logger.info(`✅ Admin already exists: ${config.admin.username}`);
  }
}

// ─────────────────────────────────────────
// ENSURE DEFAULT SETTINGS
// ─────────────────────────────────────────
async function ensureSettings(prisma) {
  const defaults = [
    { key: 'exchange_rate',        value: String(config.pricing.exchangeRate) },
    { key: 'profit_margin',        value: String(config.pricing.profitMargin) },
    { key: 'maintenance_mode',     value: 'false' },
    { key: 'channel_verification', value: 'false' },
    { key: 'referral_commission',  value: '0.05' },
    { key: 'min_deposit',          value: '10' },
    { key: 'max_deposit',          value: '10000' },
    { key: 'min_withdraw',         value: '10' },
    { key: 'max_withdraw',         value: '5000' },
    { key: 'vip_bronze_threshold', value: '100' },
    { key: 'vip_silver_threshold', value: '500' },
    { key: 'vip_gold_threshold',   value: '2000' },
    { key: 'vip_bronze_discount',  value: '0.02' },
    { key: 'vip_silver_discount',  value: '0.05' },
    { key: 'vip_gold_discount',    value: '0.10' },
    { key: 'support_min_length',   value: '20' },
    { key: 'bot_name',             value: 'خدمات التواصل الاجتماعي' },
    { key: 'welcome_message',      value: 'مرحباً بك في منصتنا للخدمات الرقمية! 🎉' },
  ];

  for (const s of defaults) {
    await prisma.setting.upsert({
      where:  { key: s.key },
      update: {},
      create: s,
    });
  }
  logger.info('✅ Default settings ensured');
}

// ─────────────────────────────────────────
// MAIN INITIALIZATION
// ─────────────────────────────────────────
async function initialize() {
  try {

    // ── 1. Push schema (ينشئ الجداول مباشرة من schema.prisma) ──
    await pushSchema();

    // ── 2. Connect Prisma ──
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient({
      log: ['error'],
    });
    await prisma.$connect();
    logger.info('✅ Database connected');

    // ── 3. Seed defaults ──
    await ensureAdmin(prisma);
    await ensureSettings(prisma);

    // ── 4. Load Express App ──
    logger.info('🔄 Loading Express application...');
    expressApp = require('./app');
    logger.info('✅ Express app loaded');

    // ── 5. Start Telegram Bot ──
    try {
      const { startBot } = require('../bot/bot');
      await startBot();
      logger.info('✅ Telegram Bot started');
    } catch (botErr) {
      logger.error(`❌ Bot error (non-fatal): ${botErr.message}`);
    }

    // ── 6. Start Background Jobs ──
    try {
      require('../jobs/orderSync');
      require('../jobs/cacheRefresh');
      require('../jobs/dailyStats');
      require('../jobs/backupJob');
      logger.info('✅ Background jobs started');
    } catch (jobErr) {
      logger.error(`❌ Jobs error (non-fatal): ${jobErr.message}`);
    }

    // ── 7. Ready ──
    appReady = true;
    logger.info('🎉 Application fully initialized and ready!');

  } catch (err) {
    logger.error(`❌ Initialization failed: ${err.message}`);
    logger.error(err.stack);
    process.exit(1);
  }
}

// ─────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('🛑 SIGTERM - shutting down...');
  rawServer.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('🛑 SIGINT - shutting down...');
  rawServer.close();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});
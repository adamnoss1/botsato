require('dotenv').config();

module.exports = {
  app: {
    port: parseInt(process.env.PORT) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    appUrl: process.env.APP_URL || 'http://localhost:3000',
    sessionSecret: process.env.SESSION_SECRET || 'fallback_secret_change_in_production',
  },

  bot: {
    token: process.env.BOT_TOKEN,
    username: process.env.BOT_USERNAME,
    adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '')
      .split(',')
      .map(id => parseInt(id.trim()))
      .filter(id => !isNaN(id)),
    supportChannelId: process.env.SUPPORT_CHANNEL_ID,
    notificationChannelId: process.env.NOTIFICATION_CHANNEL_ID,
    requiredChannelId: process.env.REQUIRED_CHANNEL_ID,
    requiredChannelUsername: process.env.REQUIRED_CHANNEL_USERNAME,
  },

  database: {
    url: process.env.DATABASE_URL,
  },

  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  },

  satofill: {
    apiKey: process.env.SATOFILL_API_KEY,
    // الـ URL الصحيح من توثيق Satofill
    apiUrl: process.env.SATOFILL_API_URL || 'https://satofill.com/wp-json/mps/v1',
  },

  pricing: {
    exchangeRate: parseFloat(process.env.EXCHANGE_RATE) || 3.75,
    profitMargin: parseFloat(process.env.PROFIT_MARGIN) || 0.20,
  },

  backup: {
    dir: process.env.BACKUP_DIR || './backups',
  },

  security: {
    maxLoginAttempts: 5,
    lockDurationMinutes: 30,
    sessionMaxAge: 24 * 60 * 60 * 1000, // 24 hours
  },

  rateLimit: {
    windowMs: 60 * 1000,
    maxRequests: 30,
  },
};
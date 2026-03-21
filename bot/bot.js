const { Telegraf, session } = require('telegraf');
const config  = require('../config/settings');
const handlers = require('./handlers');
const { telegramRateLimit } = require('../middleware/rateLimit');

let bot;

// ─────────────────────────────────────────
// CREATE BOT
// ─────────────────────────────────────────
function createBot() {
  if (!config.bot.token) throw new Error('BOT_TOKEN is not set');

  bot = new Telegraf(config.bot.token);

  // ── Session middleware - يجب أن يكون أول شيء ──
  bot.use(session({
    defaultSession: () => ({
      step:                    null,
      depositMethodId:         null,
      depositAmount:           null,
      withdrawMethodId:        null,
      withdrawAmount:          null,
      selectedProductId:       null,
      selectedManualProductId: null,
      autoQuantity:            null,
      autoLink:                null,
      manualQuantity:          null,
      manualAccountInfo:       null,
      transferTargetId:        null,
      transferAmount:          null,
      pendingReferral:         null,
    }),
  }));

  // ── Rate limiting ──
  bot.use(telegramRateLimit);

  // ── Global middleware - user check ──
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    if (ctx.from.is_bot) return;

    // ضمان وجود session دائماً
    if (!ctx.session) {
      ctx.session = {
        step:                    null,
        depositMethodId:         null,
        depositAmount:           null,
        withdrawMethodId:        null,
        withdrawAmount:          null,
        selectedProductId:       null,
        selectedManualProductId: null,
        autoQuantity:            null,
        autoLink:                null,
        manualQuantity:          null,
        manualAccountInfo:       null,
        transferTargetId:        null,
        transferAmount:          null,
        pendingReferral:         null,
      };
    }

    try {
      const { findOrCreateUser, isAdminUser } = require('../services/userService');
      const { isMaintenanceMode } = require('../services/settingsService');

      // فحص وضع الصيانة
      const maintenance = await isMaintenanceMode();
      const isAdmin     = isAdminUser(ctx.from.id);

      if (maintenance && !isAdmin) {
        return ctx.reply('🔧 البوت في وضع الصيانة. يرجى المحاولة لاحقاً.');
      }

      // إنشاء/إيجاد المستخدم
      const refCode = ctx.session.pendingReferral || null;
      const { user, isNew, referredById } = await findOrCreateUser(ctx.from, refCode);

      if (isNew && refCode) {
        ctx.session.pendingReferral = null;
        await handlers.notifyReferrer(referredById, user).catch(() => {});
      }

      // فحص الحظر
      if (user.isBanned) {
        return ctx.reply(
          `🚫 تم حظر حسابك.\nالسبب: ${user.banReason || 'مخالفة الشروط'}`
        );
      }

      ctx.dbUser = user;
    } catch (err) {
      console.error('[BOT MIDDLEWARE]', err.message);
    }

    return next();
  });

  // ── تسجيل جميع الـ handlers ──
  handlers.register(bot);

  // ── معالج الأخطاء ──
  bot.catch((err, ctx) => {
    console.error(`[BOT ERROR] Update ${ctx.updateType}:`, err.message);
    if (ctx.reply) {
      ctx.reply('❌ حدث خطأ. يرجى المحاولة مجدداً.').catch(() => {});
    }
  });

  return bot;
}

// ─────────────────────────────────────────
// START BOT
// ─────────────────────────────────────────
async function startBot() {
  createBot();

  await bot.launch({
    dropPendingUpdates: true, // تجاهل الرسائل القديمة عند إعادة التشغيل
  });

  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

module.exports = {
  startBot,
  get bot() { return bot; },
};
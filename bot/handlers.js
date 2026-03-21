const { Markup } = require('telegraf');
const keyboards  = require('./keyboards');
const userSvc    = require('../services/userService');
const walletSvc  = require('../services/walletService');
const depositSvc = require('../services/depositService');
const withdrawSvc= require('../services/withdrawService');
const orderSvc   = require('../services/orderService');
const referralSvc= require('../services/referralService');
const vipSvc     = require('../services/vipService');
const settingsSvc= require('../services/settingsService');
const notifySvc  = require('../services/notificationService');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const config = require('../config/settings');

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function formatBalance(amount) {
  return parseFloat(amount).toFixed(2);
}

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

async function checkChannelSubscription(ctx) {
  const enabled = await settingsSvc.isChannelVerificationEnabled();
  if (!enabled) return true;

  try {
    const member = await ctx.telegram.getChatMember(
      config.bot.requiredChannelId,
      ctx.from.id
    );
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────
// NOTIFY REFERRER (new user joined)
// ─────────────────────────────────────────
async function notifyReferrer(referrerId, newUser) {
  if (!referrerId) return;
  const referrer = await userSvc.getUserById(referrerId);
  if (!referrer) return;

  const { bot } = require('./bot');
  await bot.telegram.sendMessage(
    Number(referrer.telegramId),
    `🎉 انضم مستخدم جديد بواسطة رابط إحالتك!\n👤 *${escapeMarkdown(newUser.firstName)}*`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ─────────────────────────────────────────
// PROFILE MESSAGE
// ─────────────────────────────────────────
function buildProfileMessage(user) {
  const badge = vipSvc.getVipBadge(user.vipLevel);
  const label = vipSvc.getVipLabel(user.vipLevel);
  return `
👤 *ملفك الشخصي*

🏷 الاسم: *${escapeMarkdown(user.firstName)}*
📛 المعرف: ${user.username ? `@${user.username}` : 'غير محدد'}
🆔 Telegram ID: \`${user.telegramId}\`
🔢 ID الداخلي: \`${user.id}\`
💰 الرصيد: *${formatBalance(user.balance)}$*
${badge} المستوى: *${label}*
📅 تاريخ التسجيل: ${new Date(user.createdAt).toLocaleDateString('ar')}
`.trim();
}

// ─────────────────────────────────────────
// REGISTER ALL HANDLERS
// ─────────────────────────────────────────
function register(bot) {

  // ══════════════════════════════════════
  // /start COMMAND
  // ══════════════════════════════════════
  bot.start(async (ctx) => {
    const payload = ctx.startPayload;

    // Store referral code in session before user creation
    if (payload && payload.startsWith('ref_')) {
      ctx.session.pendingReferral = payload.replace('ref_', '');
    }

    const user = ctx.dbUser;
    if (!user) return;

    // Channel verification
    const subscribed = await checkChannelSubscription(ctx);
    if (!subscribed) {
      return ctx.reply(
        '📢 *يجب الاشتراك في قناتنا أولاً للاستمرار*',
        {
          parse_mode: 'Markdown',
          ...keyboards.channelVerifyKeyboard(config.bot.requiredChannelUsername),
        }
      );
    }

    const settings = await settingsSvc.getAllSettings();
    const welcome  = settings.welcome_message || 'مرحباً بك!';

    await ctx.reply(
      `${welcome}\n\n${buildProfileMessage(user)}`,
      { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
    );
  });

  // ══════════════════════════════════════
  // VERIFY SUBSCRIPTION CALLBACK
  // ══════════════════════════════════════
  bot.action('verify_subscription', async (ctx) => {
    await ctx.answerCbQuery();
    const subscribed = await checkChannelSubscription(ctx);
    if (!subscribed) {
      return ctx.answerCbQuery('❌ لم تشترك بعد في القناة!', { show_alert: true });
    }

    const user = ctx.dbUser;
    await ctx.editMessageText(
      `✅ تم التحقق!\n\n${buildProfileMessage(user)}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.reply('القائمة الرئيسية:', keyboards.mainMenu(user));
  });

  // ══════════════════════════════════════
  // MAIN MENU BUTTONS
  // ══════════════════════════════════════

  // Profile / home
  bot.hears(['🏠 الرئيسية', '/profile'], async (ctx) => {
    const user = ctx.dbUser;
    await ctx.reply(buildProfileMessage(user), {
      parse_mode: 'Markdown',
      ...keyboards.mainMenu(user),
    });
  });

  // ──────────────────────────────────────
  // 💰 WALLET
  // ──────────────────────────────────────
  bot.hears('💰 محفظتي', async (ctx) => {
    const user = ctx.dbUser;
    await ctx.reply(
      `💰 *محفظتك*\n\nرصيدك الحالي: *${formatBalance(user.balance)}$*`,
      { parse_mode: 'Markdown', ...keyboards.walletMenu() }
    );
  });

  bot.hears('💳 رصيدي', async (ctx) => {
    const user = await userSvc.getUserById(ctx.dbUser.id);
    await ctx.reply(
      `💳 رصيدك الحالي: *${formatBalance(user.balance)}$*`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.hears('🔙 القائمة الرئيسية', async (ctx) => {
    const user = ctx.dbUser;
    await ctx.reply('القائمة الرئيسية:', keyboards.mainMenu(user));
  });

  // ──────────────────────────────────────
  // ➕ DEPOSIT
  // ──────────────────────────────────────
  bot.hears('➕ إيداع', async (ctx) => {
    const methods = await depositSvc.getActiveMethods();
    if (methods.length === 0) {
      return ctx.reply('❌ لا توجد طرق إيداع متاحة حالياً.');
    }
    ctx.session.step = null;
    await ctx.reply(
      '💳 *اختر طريقة الإيداع:*',
      { parse_mode: 'Markdown', ...keyboards.depositMethodsKeyboard(methods) }
    );
  });

  bot.action(/^deposit_method_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const methodId = parseInt(ctx.match[1]);
    const method   = await prisma.depositMethod.findUnique({ where: { id: methodId } });
    if (!method) return ctx.reply('❌ الطريقة غير موجودة');

    ctx.session.depositMethodId = methodId;
    ctx.session.step = 'deposit_amount';

    const instructions = method.instructions || '';
    await ctx.editMessageText(
      `💳 *${method.name}*\n\n` +
      `📊 سعر الصرف: 1$ = ${method.exchangeRate}\n` +
      `📉 الحد الأدنى: ${method.minAmount}\n` +
      `📈 الحد الأقصى: ${method.maxAmount}\n` +
      (instructions ? `\n📋 التعليمات:\n${instructions}\n` : '') +
      `\n💰 أدخل المبلغ بالعملة المحلية:`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // ➖ WITHDRAW
  // ──────────────────────────────────────
  bot.hears('➖ سحب', async (ctx) => {
    const methods = await withdrawSvc.getActiveMethods();
    if (methods.length === 0) {
      return ctx.reply('❌ لا توجد طرق سحب متاحة حالياً.');
    }
    ctx.session.step = null;
    await ctx.reply(
      '💸 *اختر طريقة السحب:*',
      { parse_mode: 'Markdown', ...keyboards.withdrawMethodsKeyboard(methods) }
    );
  });

  bot.action(/^withdraw_method_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const methodId = parseInt(ctx.match[1]);
    const method   = await prisma.withdrawMethod.findUnique({ where: { id: methodId } });
    if (!method) return ctx.reply('❌ الطريقة غير موجودة');

    const user = await userSvc.getUserById(ctx.dbUser.id);
    const feeText = method.feeType === 'percentage'
      ? `${(parseFloat(method.feeValue) * 100).toFixed(1)}%`
      : `${method.feeValue}$`;

    ctx.session.withdrawMethodId = methodId;
    ctx.session.step = 'withdraw_amount';

    await ctx.editMessageText(
      `💸 *${method.name}*\n\n` +
      `💰 رصيدك: *${formatBalance(user.balance)}$*\n` +
      `📉 الحد الأدنى: ${method.minAmount}$\n` +
      `📈 الحد الأقصى: ${method.maxAmount}$\n` +
      `💳 الرسوم: ${feeText}\n\n` +
      `أدخل المبلغ بالدولار:`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // ↔️ TRANSFER
  // ──────────────────────────────────────
  bot.hears('↔️ تحويل رصيد', async (ctx) => {
    ctx.session.step = 'transfer_user';
    await ctx.reply(
      '↔️ *تحويل رصيد*\n\nأدخل ID المستخدم أو معرفه (@username):',
      { parse_mode: 'Markdown', ...keyboards.cancelButton() }
    );
  });

  // ──────────────────────────────────────
  // ⚡️ AUTO SERVICE
  // ──────────────────────────────────────
  bot.hears('⚡️ شحن تلقائي', async (ctx) => {
    const groups = await prisma.productGroup.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    if (groups.length === 0) {
      return ctx.reply('❌ لا توجد خدمات متاحة حالياً.');
    }

    ctx.session.step = 'auto_service';
    await ctx.reply(
      '⚡️ *اختر الفئة:*',
      { parse_mode: 'Markdown', ...keyboards.productGroupsKeyboard(groups) }
    );
  });

  bot.action(/^group_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const groupId = parseInt(ctx.match[1]);

    const products = await prisma.product.findMany({
      where: { groupId, isActive: true, isManual: false },
      orderBy: { sortOrder: 'asc' },
      take: 10,
    });

    if (products.length === 0) {
      return ctx.answerCbQuery('❌ لا توجد خدمات في هذه الفئة', { show_alert: true });
    }

    ctx.session.selectedGroupId = groupId;
    ctx.session.productsPage    = 1;

    await ctx.editMessageText(
      '📦 *اختر الخدمة:*',
      { parse_mode: 'Markdown', ...keyboards.productsKeyboard(products, 1, 1) }
    );
  });

  bot.action(/^product_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = parseInt(ctx.match[1]);
    const product   = await prisma.product.findUnique({
      where: { id: productId },
      include: { group: true },
    });

    if (!product) return ctx.reply('❌ الخدمة غير موجودة');

    const user     = await userSvc.getUserById(ctx.dbUser.id);
    const settings = await settingsSvc.getAllSettings();
    const rate     = parseFloat(settings.exchange_rate  || '3.75');
    const margin   = parseFloat(settings.profit_margin  || '0.20');
    const discount = await getVipDiscountLocal(user.vipLevel, settings);

    const pricePerUnit = parseFloat(product.priceUsd) * (1 + margin) * (1 - discount);
    const pricePer1000 = (pricePerUnit * 1000 * rate).toFixed(4);

    ctx.session.selectedProductId = productId;
    ctx.session.step = 'auto_quantity';

    await ctx.editMessageText(
      `📦 *${product.name}*\n\n` +
      `📁 الفئة: ${product.group.name}\n` +
      `💰 السعر لكل 1000: *${pricePer1000}*\n` +
      `📉 الحد الأدنى: ${product.minQuantity}\n` +
      `📈 الحد الأقصى: ${product.maxQuantity}\n` +
      (product.description ? `\n📋 ${product.description}\n` : '') +
      `\n💰 رصيدك: *${formatBalance(user.balance)}$*\n\n` +
      `أدخل الكمية المطلوبة:`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // ⚙️ MANUAL SERVICE
  // ──────────────────────────────────────
  bot.hears('⚙️ شحن يدوي', async (ctx) => {
    const products = await prisma.product.findMany({
      where: { isActive: true, isManual: true },
      include: { group: true },
      orderBy: { sortOrder: 'asc' },
    });

    if (products.length === 0) {
      return ctx.reply('❌ لا توجد خدمات يدوية متاحة حالياً.');
    }

    const buttons = products.map(p => [
      Markup.button.callback(
        `${p.group.name} - ${p.name}`,
        `manual_product_${p.id}`
      ),
    ]);
    buttons.push([Markup.button.callback('❌ إلغاء', 'cancel')]);

    await ctx.reply(
      '⚙️ *اختر الخدمة اليدوية:*',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  });

  bot.action(/^manual_product_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = parseInt(ctx.match[1]);
    const product   = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return ctx.reply('❌ المنتج غير موجود');

    const user     = await userSvc.getUserById(ctx.dbUser.id);
    const settings = await settingsSvc.getAllSettings();
    const rate     = parseFloat(settings.exchange_rate || '3.75');
    const priceLocal = (parseFloat(product.priceUsd) * rate).toFixed(4);

    ctx.session.selectedManualProductId = productId;
    ctx.session.step = 'manual_quantity';

    await ctx.editMessageText(
      `⚙️ *${product.name}*\n\n` +
      `💰 السعر للوحدة: *${priceLocal}*\n` +
      `📉 الحد الأدنى: ${product.minQuantity}\n` +
      `📈 الحد الأقصى: ${product.maxQuantity}\n` +
      `\n💰 رصيدك: *${formatBalance(user.balance)}$*\n\n` +
      `أدخل الكمية:`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // 📊 TRANSACTIONS
  // ──────────────────────────────────────
  bot.hears('📊 معاملاتي', async (ctx) => {
    await ctx.reply('📊 *سجل المعاملات*\nاختر نوع السجل:', {
      parse_mode: 'Markdown',
      ...keyboards.transactionsMenu(),
    });
  });

  bot.hears('📥 سجل الإيداعات', async (ctx) => {
    const { deposits, total } = await depositSvc.getDeposits({
      userId: ctx.dbUser.id,
      page: 1,
      limit: 5,
    });

    if (deposits.length === 0) {
      return ctx.reply('📭 لا توجد إيداعات بعد.');
    }

    let msg = '📥 *سجل الإيداعات الأخيرة:*\n\n';
    for (const d of deposits) {
      const statusEmoji = { PENDING: '⏳', APPROVED: '✅', REJECTED: '❌' }[d.status] || '❓';
      msg += `${statusEmoji} ${parseFloat(d.amountUsd).toFixed(2)}$ | ${d.method?.name || ''} | ${new Date(d.createdAt).toLocaleDateString('ar')}\n`;
    }
    msg += `\nالإجمالي: ${total} معاملة`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.hears('📤 سجل السحوبات', async (ctx) => {
    const { withdrawals, total } = await withdrawSvc.getWithdrawals({
      userId: ctx.dbUser.id,
      page: 1,
      limit: 5,
    });

    if (withdrawals.length === 0) {
      return ctx.reply('📭 لا توجد سحوبات بعد.');
    }

    let msg = '📤 *سجل السحوبات الأخيرة:*\n\n';
    for (const w of withdrawals) {
      const statusEmoji = {
        PENDING: '⏳', APPROVED: '🔄', COMPLETED: '✅', REJECTED: '❌',
      }[w.status] || '❓';
      msg += `${statusEmoji} ${parseFloat(w.netAmount).toFixed(2)}$ | ${w.method?.name || ''} | ${new Date(w.createdAt).toLocaleDateString('ar')}\n`;
    }
    msg += `\nالإجمالي: ${total} معاملة`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.hears('📦 سجل الطلبات', async (ctx) => {
    const { orders, total } = await orderSvc.getOrders({
      userId: ctx.dbUser.id,
      page: 1,
      limit: 5,
    });

    if (orders.length === 0) return ctx.reply('📭 لا توجد طلبات بعد.');

    let msg = '📦 *آخر الطلبات:*\n\n';
    for (const o of orders) {
      const emoji = {
        PENDING: '⏳', PROCESSING: '🔄', COMPLETED: '✅',
        PARTIAL: '⚠️', CANCELLED: '🚫', FAILED: '❌',
      }[o.status] || '❓';
      msg += `${emoji} #${o.id} | ${o.product?.name || ''} | ${o.quantity} | ${parseFloat(o.totalPrice).toFixed(2)}$\n`;
    }
    msg += `\nالإجمالي: ${total} طلب`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.hears('⏳ الطلبات النشطة', async (ctx) => {
    const { orders } = await orderSvc.getOrders({
      userId: ctx.dbUser.id,
      status: 'PROCESSING',
      limit:  10,
    });

    if (orders.length === 0) return ctx.reply('✅ لا توجد طلبات نشطة حالياً.');

    let msg = '⏳ *الطلبات النشطة:*\n\n';
    for (const o of orders) {
      msg += `🔄 #${o.id} | ${o.product?.name || ''}\n`;
      msg += `   الكمية: ${o.quantity} | المتبقي: ${o.remains ?? '—'}\n\n`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ──────────────────────────────────────
  // 👥 REFERRAL
  // ──────────────────────────────────────
  bot.hears('👥 الإحالة', async (ctx) => {
    const user  = ctx.dbUser;
    const stats = await referralSvc.getReferralStats(user.id);
    const link  = `https://t.me/${config.bot.username}?start=ref_${user.referralCode}`;

    const msg =
      `👥 *نظام الإحالة*\n\n` +
      `🔗 رابطك الخاص:\n\`${link}\`\n\n` +
      `👤 المستخدمون المدعوون: *${stats.invitedCount}*\n` +
      `💰 إجمالي العمولات: *${stats.totalCommission.toFixed(2)}$*\n` +
      `📦 الطلبات المكملة: *${stats.totalOrders}*\n\n` +
      `💡 احصل على عمولة على كل طلب يقوم به المستخدمون المدعوون!`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ──────────────────────────────────────
  // 🎧 SUPPORT
  // ──────────────────────────────────────
  bot.hears('🎧 الدعم الفني', async (ctx) => {
    const minLength = parseInt(
      await settingsSvc.getSetting('support_min_length') || '20'
    );
    ctx.session.step = 'support_message';
    await ctx.reply(
      `🎧 *الدعم الفني*\n\nأرسل رسالتك وسيتم الرد عليها في أقرب وقت.\n_الحد الأدنى: ${minLength} حرف_`,
      { parse_mode: 'Markdown', ...keyboards.cancelButton() }
    );
  });

  // ──────────────────────────────────────
  // 🔧 BOT SYSTEMS
  // ──────────────────────────────────────
  bot.hears('🔧 أنظمة البوت', async (ctx) => {
    const settings = await settingsSvc.getAllSettings();
    const msg =
      `🔧 *معلومات النظام*\n\n` +
      `💱 سعر الصرف: *${settings.exchange_rate || '3.75'}*\n` +
      `📊 هامش الربح: *${((parseFloat(settings.profit_margin || '0.20')) * 100).toFixed(0)}%*\n` +
      `🔧 الصيانة: *${settings.maintenance_mode === 'true' ? 'مفعّل' : 'غير مفعّل'}*\n` +
      `📢 التحقق من القناة: *${settings.channel_verification === 'true' ? 'مفعّل' : 'غير مفعّل'}*`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ──────────────────────────────────────
  // 📢 ANNOUNCEMENTS
  // ──────────────────────────────────────
  bot.hears('📢 الإعلانات', async (ctx) => {
    const latest = await prisma.broadcastLog.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (!latest) return ctx.reply('📭 لا توجد إعلانات حالياً.');

    await ctx.reply(
      `📢 *آخر إعلان:*\n\n${latest.message}\n\n_${new Date(latest.createdAt).toLocaleDateString('ar')}_`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // ❌ CANCEL
  // ──────────────────────────────────────
  bot.hears('❌ إلغاء', async (ctx) => {
    ctx.session.step = null;
    ctx.session.depositMethodId        = null;
    ctx.session.withdrawMethodId       = null;
    ctx.session.selectedProductId      = null;
    ctx.session.selectedManualProductId= null;
    ctx.session.transferTarget         = null;
    ctx.session.transferAmount         = null;
    await ctx.reply('❌ تم الإلغاء.', keyboards.mainMenu(ctx.dbUser));
  });

  bot.action('cancel', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = null;
    await ctx.editMessageText('❌ تم الإلغاء.');
  });

  // ──────────────────────────────────────
  // ADMIN CALLBACK - DEPOSIT APPROVE/REJECT
  // ──────────────────────────────────────
  bot.action(/^deposit_approve_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!userSvc.isAdminUser(ctx.from.id)) return;

    const depositId = parseInt(ctx.match[1]);
    try {
      const deposit = await depositSvc.approveDeposit(depositId, null);
      await ctx.editMessageText(`✅ تمت الموافقة على الإيداع #${depositId}`);
      await notifySvc.notifyUserDepositApproved(
        deposit.user?.telegramId || 0,
        deposit.amountUsd
      ).catch(() => {});
    } catch (err) {
      await ctx.answerCbQuery(`❌ ${err.message}`, { show_alert: true });
    }
  });

  bot.action(/^deposit_reject_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!userSvc.isAdminUser(ctx.from.id)) return;

    const depositId = parseInt(ctx.match[1]);
    try {
      const deposit = await depositSvc.rejectDeposit(depositId);
      await ctx.editMessageText(`❌ تم رفض الإيداع #${depositId}`);
      await notifySvc.notifyUserDepositRejected(
        deposit.user?.telegramId || 0
      ).catch(() => {});
    } catch (err) {
      await ctx.answerCbQuery(`❌ ${err.message}`, { show_alert: true });
    }
  });

  // ──────────────────────────────────────
  // ADMIN CALLBACK - WITHDRAW APPROVE/REJECT
  // ──────────────────────────────────────
  bot.action(/^withdraw_approve_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!userSvc.isAdminUser(ctx.from.id)) return;

    const wId = parseInt(ctx.match[1]);
    try {
      await withdrawSvc.approveWithdrawal(wId);
      await ctx.editMessageText(`✅ تمت الموافقة على السحب #${wId}`);
    } catch (err) {
      await ctx.answerCbQuery(`❌ ${err.message}`, { show_alert: true });
    }
  });

  bot.action(/^withdraw_reject_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!userSvc.isAdminUser(ctx.from.id)) return;

    const wId = parseInt(ctx.match[1]);
    try {
      await withdrawSvc.rejectWithdrawal(wId, 'رفض من المدير');
      await ctx.editMessageText(`❌ تم رفض السحب #${wId}`);
    } catch (err) {
      await ctx.answerCbQuery(`❌ ${err.message}`, { show_alert: true });
    }
  });

  // ──────────────────────────────────────
  // NOOP (pagination label)
  // ──────────────────────────────────────
  bot.action('noop', (ctx) => ctx.answerCbQuery());

  // ──────────────────────────────────────
  // TEXT MESSAGE HANDLER (wizard steps)
  // ──────────────────────────────────────
  bot.on('text', async (ctx) => {
    const step = ctx.session?.step;
    const text = ctx.message.text.trim();
    const user = ctx.dbUser;

    if (!step) return;

    // ── DEPOSIT: amount step ──
    if (step === 'deposit_amount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply('❌ أدخل مبلغاً صحيحاً');
      }
      ctx.session.depositAmount = amount;
      ctx.session.step = 'deposit_txid';
      return ctx.reply('📋 أدخل رقم المعاملة (Transaction ID):', keyboards.cancelButton());
    }

    // ── DEPOSIT: transaction ID step ──
    if (step === 'deposit_txid') {
      const txId     = text;
      const methodId = ctx.session.depositMethodId;
      const amount   = ctx.session.depositAmount;

      try {
        const deposit = await depositSvc.createDeposit(user.id, methodId, amount, txId);
        ctx.session.step = null;
        ctx.session.depositMethodId = null;
        ctx.session.depositAmount   = null;

        await ctx.reply(
          `✅ *تم إرسال طلب الإيداع*\n\n` +
          `💰 المبلغ: ${amount}\n` +
          `🔢 رقم المعاملة: \`${txId}\`\n` +
          `⏳ بانتظار موافقة المدير...`,
          { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── WITHDRAW: amount step ──
    if (step === 'withdraw_amount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) return ctx.reply('❌ أدخل مبلغاً صحيحاً');

      const method = await prisma.withdrawMethod.findUnique({
        where: { id: ctx.session.withdrawMethodId },
      });
      const { fee, netAmount } = withdrawSvc.calculateFee(method, amount);

      ctx.session.withdrawAmount = amount;
      ctx.session.step = 'withdraw_account';

      return ctx.reply(
        `💸 المبلغ: ${amount}$\n💳 الرسوم: ${fee}$\n✅ الصافي: ${netAmount}$\n\nأدخل معلومات حسابك:`,
        keyboards.cancelButton()
      );
    }

    // ── WITHDRAW: account info step ──
    if (step === 'withdraw_account') {
      const accountInfo = text;
      const methodId    = ctx.session.withdrawMethodId;
      const amount      = ctx.session.withdrawAmount;

      try {
        const currentUser = await userSvc.getUserById(user.id);
        const method      = await prisma.withdrawMethod.findUnique({ where: { id: methodId } });
        const withdrawal  = await withdrawSvc.createWithdrawal(
          user.id, methodId, amount, accountInfo
        );

        await notifySvc.notifyAdminsWithdrawal(withdrawal, currentUser, method).catch(() => {});

        ctx.session.step = null;
        ctx.session.withdrawMethodId = null;
        ctx.session.withdrawAmount   = null;

        await ctx.reply(
          `✅ *تم إرسال طلب السحب*\n\nالمبلغ: ${amount}$\n⏳ بانتظار المعالجة...`,
          { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── TRANSFER: find user step ──
    if (step === 'transfer_user') {
      let target;
      const numId = parseInt(text);

      if (!isNaN(numId)) {
        target = await userSvc.getUserById(numId);
      } else if (text.startsWith('@')) {
        target = await prisma.user.findFirst({
          where: { username: { equals: text.slice(1), mode: 'insensitive' } },
        });
      }

      if (!target) return ctx.reply('❌ المستخدم غير موجود');
      if (target.id === user.id) return ctx.reply('❌ لا يمكن التحويل لنفسك');

      ctx.session.transferTargetId = target.id;
      ctx.session.step = 'transfer_amount';

      return ctx.reply(
        `👤 المستلم: *${escapeMarkdown(target.firstName)}*\n\nأدخل المبلغ بالدولار:`,
        { parse_mode: 'Markdown', ...keyboards.cancelButton() }
      );
    }

    // ── TRANSFER: amount step ──
    if (step === 'transfer_amount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) return ctx.reply('❌ أدخل مبلغاً صحيحاً');

      try {
        await walletSvc.transferBalance(user.id, ctx.session.transferTargetId, amount);
        const target = await userSvc.getUserById(ctx.session.transferTargetId);

        ctx.session.step = null;
        ctx.session.transferTargetId = null;

        await ctx.reply(
          `✅ تم تحويل *${amount}$* إلى *${escapeMarkdown(target.firstName)}* بنجاح`,
          { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── AUTO SERVICE: quantity step ──
    if (step === 'auto_quantity') {
      const qty = parseInt(text);
      if (isNaN(qty) || qty <= 0) return ctx.reply('❌ أدخل كمية صحيحة');

      ctx.session.autoQuantity = qty;
      ctx.session.step = 'auto_link';

      return ctx.reply('🔗 أدخل رابط الحساب:', keyboards.cancelButton());
    }

    // ── AUTO SERVICE: link step ──
    if (step === 'auto_link') {
      const link      = text;
      const productId = ctx.session.selectedProductId;
      const quantity  = ctx.session.autoQuantity;

      // Duplicate check
      const isDuplicate = await orderSvc.checkDuplicateOrder(user.id, productId);
      if (isDuplicate) {
        return ctx.reply('⚠️ لديك طلب مماثل في آخر 5 دقائق. هل تريد المتابعة؟',
          keyboards.confirmCancel()
        );
      }

      ctx.session.autoLink = link;
      ctx.session.step = 'auto_confirm';

      const product  = await prisma.product.findUnique({ where: { id: productId } });
      const settings = await settingsSvc.getAllSettings();
      const rate     = parseFloat(settings.exchange_rate || '3.75');
      const margin   = parseFloat(settings.profit_margin || '0.20');
      const discount = await getVipDiscountLocal(user.vipLevel, settings);

      const pricePerUnit = parseFloat(product.priceUsd) * (1 + margin) * (1 - discount);
      const totalLocal   = (pricePerUnit * quantity * rate).toFixed(4);

      return ctx.reply(
        `📋 *تأكيد الطلب*\n\n` +
        `📦 الخدمة: ${product.name}\n` +
        `🔢 الكمية: ${quantity}\n` +
        `🔗 الرابط: ${link}\n` +
        `💰 الإجمالي: *${totalLocal}$*\n\n` +
        `هل تريد تأكيد الطلب؟`,
        { parse_mode: 'Markdown', ...keyboards.confirmCancel() }
      );
    }

    // ── AUTO SERVICE: confirm ──
    if (step === 'auto_confirm') {
      if (text === '✅ تأكيد') {
        try {
          const order = await orderSvc.createAutoOrder(
            user.id,
            ctx.session.selectedProductId,
            ctx.session.autoQuantity,
            ctx.session.autoLink
          );

          ctx.session.step = null;
          ctx.session.selectedProductId = null;
          ctx.session.autoQuantity = null;
          ctx.session.autoLink = null;

          await ctx.reply(
            `✅ *تم إنشاء الطلب بنجاح*\n\n🆔 رقم الطلب: \`${order.id}\`\n⏳ جاري المعالجة...`,
            { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
          );
        } catch (err) {
          await ctx.reply(`❌ ${err.message}`);
        }
      } else {
        ctx.session.step = null;
        await ctx.reply('❌ تم الإلغاء.', keyboards.mainMenu(user));
      }
      return;
    }

    // ── MANUAL SERVICE: quantity step ──
    if (step === 'manual_quantity') {
      const qty = parseInt(text);
      if (isNaN(qty) || qty <= 0) return ctx.reply('❌ أدخل كمية صحيحة');

      ctx.session.manualQuantity = qty;
      ctx.session.step = 'manual_account';

      return ctx.reply('📋 أدخل معلومات الحساب:', keyboards.cancelButton());
    }

    // ── MANUAL SERVICE: account info step ──
    if (step === 'manual_account') {
      ctx.session.manualAccountInfo = text;
      ctx.session.step = 'manual_confirm';

      const productId = ctx.session.selectedManualProductId;
      const product   = await prisma.product.findUnique({ where: { id: productId } });
      const settings  = await settingsSvc.getAllSettings();
      const rate      = parseFloat(settings.exchange_rate || '3.75');
      const total     = (parseFloat(product.priceUsd) * ctx.session.manualQuantity * rate).toFixed(4);

      return ctx.reply(
        `📋 *تأكيد الطلب اليدوي*\n\n` +
        `📦 الخدمة: ${product.name}\n` +
        `🔢 الكمية: ${ctx.session.manualQuantity}\n` +
        `📋 الحساب: ${text}\n` +
        `💰 الإجمالي: *${total}$*\n\nهل تريد تأكيد الطلب؟`,
        { parse_mode: 'Markdown', ...keyboards.confirmCancel() }
      );
    }

    // ── MANUAL SERVICE: confirm ──
    if (step === 'manual_confirm') {
      if (text === '✅ تأكيد') {
        try {
          const order = await orderSvc.createManualOrder(
            user.id,
            ctx.session.selectedManualProductId,
            ctx.session.manualQuantity,
            ctx.session.manualAccountInfo
          );

          ctx.session.step = null;
          ctx.session.selectedManualProductId = null;
          ctx.session.manualQuantity = null;
          ctx.session.manualAccountInfo = null;

          await ctx.reply(
            `✅ *تم إرسال الطلب اليدوي*\n\n🆔 رقم الطلب: \`${order.id}\`\n⏳ بانتظار موافقة المدير`,
            { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
          );
        } catch (err) {
          await ctx.reply(`❌ ${err.message}`);
        }
      } else {
        ctx.session.step = null;
        await ctx.reply('❌ تم الإلغاء.', keyboards.mainMenu(user));
      }
      return;
    }

    // ── SUPPORT: message step ──
    if (step === 'support_message') {
      const minLength = parseInt(
        await settingsSvc.getSetting('support_min_length') || '20'
      );

      if (text.length < minLength) {
        return ctx.reply(`❌ الرسالة قصيرة جداً. الحد الأدنى ${minLength} حرف.`);
      }

      const freshUser = await userSvc.getUserById(user.id);

      await prisma.supportMessage.create({
        data: { userId: user.id, message: text },
      });

      // Forward to support channel
      const { bot } = require('./bot');
      const supportMsg =
        `🎧 *رسالة دعم جديدة*\n\n` +
        `👤 ${freshUser.firstName}\n` +
        `🆔 ID: \`${freshUser.id}\`\n` +
        `📱 Telegram: \`${freshUser.telegramId}\`\n` +
        `💰 الرصيد: ${formatBalance(freshUser.balance)}$\n\n` +
        `📝 الرسالة:\n${text}`;

      await bot.telegram.sendMessage(
        config.bot.supportChannelId,
        supportMsg,
        { parse_mode: 'Markdown' }
      ).catch(() => {});

      ctx.session.step = null;

      await ctx.reply(
        '✅ تم إرسال رسالتك للدعم الفني. سيتم الرد عليك قريباً.',
        keyboards.mainMenu(user)
      );
      return;
    }
  });
}

// ─────────────────────────────────────────
// HELPER - GET VIP DISCOUNT FROM SETTINGS
// ─────────────────────────────────────────
async function getVipDiscountLocal(vipLevel, settings) {
  const map = {
    NORMAL: 0,
    BRONZE: parseFloat(settings.vip_bronze_discount || '0.02'),
    SILVER: parseFloat(settings.vip_silver_discount || '0.05'),
    GOLD:   parseFloat(settings.vip_gold_discount   || '0.10'),
  };
  return map[vipLevel] || 0;
}

module.exports = { register, notifyReferrer };
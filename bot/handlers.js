// bot/handlers.js
const { Markup }  = require('telegraf');
const keyboards   = require('./keyboards');
const userSvc     = require('../services/userService');
const walletSvc   = require('../services/walletService');
const depositSvc  = require('../services/depositService');
const withdrawSvc = require('../services/withdrawService');
const orderSvc    = require('../services/orderService');
const referralSvc = require('../services/referralService');
const vipSvc      = require('../services/vipService');
const settingsSvc = require('../services/settingsService');
const notifySvc   = require('../services/notificationService');
const { PrismaClient } = require('@prisma/client');
const prisma  = new PrismaClient();
const config  = require('../config/settings');

const PRODUCTS_PER_PAGE = 8;

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function formatBalance(amount) {
  return parseFloat(amount || 0).toFixed(2);
}

function escapeMarkdown(text) {
  return String(text || '').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
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

async function getVipDiscount(vipLevel, settings) {
  const map = {
    NORMAL: 0,
    BRONZE: parseFloat(settings.vip_bronze_discount || '0.02'),
    SILVER: parseFloat(settings.vip_silver_discount || '0.05'),
    GOLD:   parseFloat(settings.vip_gold_discount   || '0.10'),
  };
  return map[vipLevel] || 0;
}

async function safeReply(ctx, text, extra) {
  try {
    return await ctx.reply(text, extra);
  } catch (err) {
    if (global.logger) global.logger.error('[BOT] safeReply: ' + err.message);
  }
}

// ─────────────────────────────────────────
// NOTIFY REFERRER
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
  return (
    `👤 *ملفك الشخصي*\n\n` +
    `🏷 *الاسم:* ${escapeMarkdown(user.firstName)}\n` +
    `📛 *المعرف:* ${user.username ? `@${user.username}` : 'غير محدد'}\n` +
    `🆔 *Telegram ID:* \`${user.telegramId}\`\n` +
    `🔢 *ID الداخلي:* \`${user.id}\`\n` +
    `💰 *الرصيد:* \`${formatBalance(user.balance)}$\`\n` +
    `${badge} *المستوى:* ${label}\n` +
    `📅 *تاريخ الانضمام:* ${new Date(user.createdAt).toLocaleDateString('ar')}`
  );
}

// ─────────────────────────────────────────
// REGISTER ALL HANDLERS
// ─────────────────────────────────────────
function register(bot) {

  // ══════════════════════════════════════
  // /start
  // ══════════════════════════════════════
  bot.start(async (ctx) => {
    const payload = ctx.startPayload;
    if (payload && payload.startsWith('ref_')) {
      ctx.session.pendingReferral = payload.replace('ref_', '');
    }
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ حدث خطأ. حاول مجدداً.');

    const subscribed = await checkChannelSubscription(ctx);
    if (!subscribed) {
      return safeReply(ctx,
        `📢 *يجب الاشتراك في قناتنا أولاً للمتابعة*\n\nاضغط على الزر أدناه للانضمام ثم تحقق من اشتراكك`,
        { parse_mode: 'Markdown', ...keyboards.channelVerifyKeyboard(config.bot.requiredChannelUsername) }
      );
    }

    const settings = await settingsSvc.getAllSettings();
    const welcome  = settings.welcome_message || 'مرحباً بك! 👋';

    await safeReply(ctx,
      `${welcome}\n\n${buildProfileMessage(user)}`,
      { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
    );
  });

  bot.action('verify_subscription', async (ctx) => {
    await ctx.answerCbQuery();
    const subscribed = await checkChannelSubscription(ctx);
    if (!subscribed) {
      return ctx.answerCbQuery('❌ لم تشترك بعد! اضغط على رابط القناة أولاً', { show_alert: true });
    }
    const user = ctx.dbUser;
    if (!user) return;
    await ctx.editMessageText(
      `✅ *تم التحقق بنجاح!*\n\n${buildProfileMessage(user)}`,
      { parse_mode: 'Markdown' }
    );
    await safeReply(ctx, '🏠 القائمة الرئيسية:', keyboards.mainMenu(user));
  });

  // ══════════════════════════════════════
  // MAIN MENU
  // ══════════════════════════════════════
  bot.hears(['🏠 الرئيسية', '/profile'], async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    await safeReply(ctx, buildProfileMessage(user), {
      parse_mode: 'Markdown', ...keyboards.mainMenu(user),
    });
  });

  // ──────────────────────────────────────
  // 💰 WALLET
  // ──────────────────────────────────────
  bot.hears('💰 محفظتي', async (ctx) => {
    const user  = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const fresh = await userSvc.getUserById(user.id);
    await safeReply(ctx,
      `💰 *محفظتك*\n\n💵 رصيدك الحالي: \`${formatBalance(fresh.balance)}$\`\n\nاختر العملية:`,
      { parse_mode: 'Markdown', ...keyboards.walletMenu() }
    );
  });

  bot.hears('💳 رصيدي', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const fresh = await userSvc.getUserById(user.id);
    await safeReply(ctx,
      `💵 رصيدك الحالي: \`${formatBalance(fresh.balance)}$\``,
      { parse_mode: 'Markdown' }
    );
  });

  bot.hears('🔙 القائمة الرئيسية', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    ctx.session.step = null;
    await safeReply(ctx, '🏠 القائمة الرئيسية:', keyboards.mainMenu(user));
  });

  // ──────────────────────────────────────
  // ➕ DEPOSIT
  // ──────────────────────────────────────
  bot.hears('➕ إيداع', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const methods = await depositSvc.getActiveMethods();
    if (methods.length === 0) return safeReply(ctx, '❌ لا توجد طرق إيداع متاحة حالياً.');
    ctx.session.step = null;
    await safeReply(ctx,
      `➕ *إيداع الرصيد*\n\nاختر طريقة الإيداع:`,
      { parse_mode: 'Markdown', ...keyboards.depositMethodsKeyboard(methods) }
    );
  });

  bot.action(/^deposit_method_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.dbUser;
    if (!user) return;
    const methodId = parseInt(ctx.match[1]);
    const method   = await prisma.depositMethod.findUnique({ where: { id: methodId } });
    if (!method || !method.isActive) {
      return ctx.answerCbQuery('❌ الطريقة غير متاحة حالياً', { show_alert: true });
    }
    ctx.session.depositMethodId = methodId;
    ctx.session.step = 'deposit_amount';
    const instructions = method.instructions || '';
    await ctx.editMessageText(
      `💳 *${escapeMarkdown(method.name)}*\n\n` +
      `📊 سعر الصرف: \`1$ = ${method.exchangeRate}\`\n` +
      `📉 الحد الأدنى: \`${method.minAmount}\`\n` +
      `📈 الحد الأقصى: \`${method.maxAmount}\`\n` +
      (instructions ? `\n📋 التعليمات:\n${escapeMarkdown(instructions)}\n` : '') +
      `\n✏️ أدخل المبلغ بالعملة المحلية:`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // ➖ WITHDRAW
  // ──────────────────────────────────────
  bot.hears('➖ سحب', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const methods = await withdrawSvc.getActiveMethods();
    if (methods.length === 0) return safeReply(ctx, '❌ لا توجد طرق سحب متاحة حالياً.');
    ctx.session.step = null;
    await safeReply(ctx,
      `➖ *سحب الرصيد*\n\nاختر طريقة السحب:`,
      { parse_mode: 'Markdown', ...keyboards.withdrawMethodsKeyboard(methods) }
    );
  });

  bot.action(/^withdraw_method_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.dbUser;
    if (!user) return;
    const methodId     = parseInt(ctx.match[1]);
    const method       = await prisma.withdrawMethod.findUnique({ where: { id: methodId } });
    if (!method || !method.isActive) {
      return ctx.answerCbQuery('❌ الطريقة غير متاحة', { show_alert: true });
    }
    const fresh        = await userSvc.getUserById(user.id);
    const exchangeRate = parseFloat(method.exchangeRate) || 1;
    const isLocal      = exchangeRate !== 1;
    const feeText      = method.feeType === 'percentage'
      ? `${(parseFloat(method.feeValue) * 100).toFixed(1)}%`
      : `${method.feeValue}$`;
    const minUsd   = parseFloat(method.minAmount);
    const maxUsd   = parseFloat(method.maxAmount);
    const minLocal = isLocal ? ` ≈ ${(minUsd * exchangeRate).toFixed(2)} محلي` : '';
    const maxLocal = isLocal ? ` ≈ ${(maxUsd * exchangeRate).toFixed(2)} محلي` : '';

    ctx.session.withdrawMethodId = methodId;
    ctx.session.step = 'withdraw_amount';

    await ctx.editMessageText(
      `💸 *${escapeMarkdown(method.name)}*\n\n` +
      `💵 رصيدك: \`${formatBalance(fresh.balance)}$\`\n` +
      `💱 سعر الصرف: ${isLocal ? `\`1$ = ${exchangeRate}\`` : 'بالدولار مباشرة'}\n` +
      `📉 الحد الأدنى: \`${minUsd}$\`${minLocal}\n` +
      `📈 الحد الأقصى: \`${maxUsd}$\`${maxLocal}\n` +
      `💳 الرسوم: \`${feeText}\`\n` +
      (method.instructions ? `\n📋 ${escapeMarkdown(method.instructions)}\n` : '') +
      `\n✏️ أدخل المبلغ بالدولار:`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // ↔️ TRANSFER
  // ──────────────────────────────────────
  bot.hears('↔️ تحويل رصيد', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    ctx.session.step = 'transfer_user';
    await safeReply(ctx,
      `↔️ *تحويل الرصيد*\n\n✏️ أدخل ID المستخدم الداخلي أو معرفه (@username):`,
      { parse_mode: 'Markdown', ...keyboards.cancelButton() }
    );
  });

  // ──────────────────────────────────────
  // ⚡️ AUTO SERVICE
  // ──────────────────────────────────────
  bot.hears('⚡️ شحن تلقائي', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');

    const rootGroups = await prisma.productGroup.findMany({
      where:   { isActive: true, parentId: null },
      orderBy: { sortOrder: 'asc' },
    });

    if (rootGroups.length === 0) {
      return safeReply(ctx, '❌ لا توجد خدمات متاحة حالياً.');
    }

    ctx.session.step            = 'auto_service';
    ctx.session.groupPath       = [];
    ctx.session.selectedGroupId = null;

    await safeReply(ctx,
      `⚡️ *الشحن التلقائي*\n\n📂 اختر التصنيف:`,
      { parse_mode: 'Markdown', ...keyboards.productGroupsKeyboard(rootGroups, null) }
    );
  });

  // ── اختيار تصنيف ──
  bot.action(/^group_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.dbUser;
    if (!user) return;

    const groupId = parseInt(ctx.match[1]);
    const group   = await prisma.productGroup.findUnique({
      where:   { id: groupId },
      include: { children: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
    });

    if (!group) return ctx.answerCbQuery('❌ التصنيف غير موجود', { show_alert: true });

    const limit = PRODUCTS_PER_PAGE;
    const [directProducts, directTotal] = await Promise.all([
      prisma.product.findMany({
        where:   { groupId, isActive: true, isManual: false },
        orderBy: { sortOrder: 'asc' },
        take:    limit,
      }),
      prisma.product.count({ where: { groupId, isActive: true, isManual: false } }),
    ]);

    const hasChildren = group.children && group.children.length > 0;
    const hasProducts = directProducts.length > 0;

    if (!hasChildren && !hasProducts) {
      return ctx.answerCbQuery('❌ لا توجد خدمات في هذا التصنيف', { show_alert: true });
    }

    ctx.session.selectedGroupId = groupId;
    ctx.session.productsPage    = 1;
    ctx.session.groupPath       = [...(ctx.session.groupPath || []), groupId];

    const buttons = [];
    const icons   = ['🎮','📱','💎','🎯','🔥','⭐','🎁','🏆','💻','🎪'];

    // التصنيفات الفرعية بصفين
    if (hasChildren) {
      for (let i = 0; i < group.children.length; i += 2) {
        const row = [
          Markup.button.callback(
            `${icons[i % icons.length]} ${group.children[i].name}`,
            `group_${group.children[i].id}`
          ),
        ];
        if (group.children[i + 1]) {
          row.push(Markup.button.callback(
            `${icons[(i + 1) % icons.length]} ${group.children[i + 1].name}`,
            `group_${group.children[i + 1].id}`
          ));
        }
        buttons.push(row);
      }
    }

    if (hasChildren && hasProducts) {
      buttons.push([Markup.button.callback('─── الخدمات المتاحة ───', 'noop')]);
    }

    directProducts.forEach(p => {
      buttons.push([Markup.button.callback(`⚡ ${p.name}`, `product_${p.id}`)]);
    });

    if (directTotal > limit) {
      buttons.push([Markup.button.callback(
        `التالي ▶️  (${directTotal - limit} خدمة أخرى)`,
        `products_page_2`
      )]);
    }

    const path = ctx.session.groupPath || [];
    if (path.length > 1) {
      buttons.push([Markup.button.callback('🔙 رجوع', `back_to_group_${path[path.length - 2]}`)]);
    } else {
      buttons.push([Markup.button.callback('🔙 رجوع للتصنيفات', 'back_to_groups')]);
    }

    const headerText =
      `📂 *${escapeMarkdown(group.name)}*\n` +
      (hasChildren && hasProducts
        ? `\nيحتوي على تصنيفات فرعية وخدمات مباشرة:`
        : hasChildren
        ? `\nاختر التصنيف الفرعي:`
        : `\nاختر الخدمة:`);

    await ctx.editMessageText(headerText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  });

  // ── الرجوع للتصنيفات الرئيسية ──
  bot.action('back_to_groups', async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.dbUser;
    if (!user) return;

    ctx.session.groupPath       = [];
    ctx.session.selectedGroupId = null;

    const rootGroups = await prisma.productGroup.findMany({
      where:   { isActive: true, parentId: null },
      orderBy: { sortOrder: 'asc' },
    });

    await ctx.editMessageText(
      `📂 *اختر التصنيف:*`,
      { parse_mode: 'Markdown', ...keyboards.productGroupsKeyboard(rootGroups, null) }
    );
  });

  // ── الرجوع للتصنيف الأب ──
  bot.action(/^back_to_group_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.dbUser;
    if (!user) return;

    const parentId = parseInt(ctx.match[1]);
    if (ctx.session.groupPath && ctx.session.groupPath.length > 0) {
      ctx.session.groupPath = ctx.session.groupPath.slice(0, -1);
    }

    const parent = await prisma.productGroup.findUnique({
      where:   { id: parentId },
      include: { children: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
    });

    if (!parent) return;

    const limit = PRODUCTS_PER_PAGE;
    const [directProducts, directTotal] = await Promise.all([
      prisma.product.findMany({
        where:   { groupId: parentId, isActive: true, isManual: false },
        orderBy: { sortOrder: 'asc' },
        take:    limit,
      }),
      prisma.product.count({ where: { groupId: parentId, isActive: true, isManual: false } }),
    ]);

    const hasChildren = parent.children && parent.children.length > 0;
    const hasProducts = directProducts.length > 0;
    const buttons     = [];
    const icons       = ['🎮','📱','💎','🎯','🔥','⭐','🎁','🏆','💻','🎪'];

    if (hasChildren) {
      for (let i = 0; i < parent.children.length; i += 2) {
        const row = [
          Markup.button.callback(
            `${icons[i % icons.length]} ${parent.children[i].name}`,
            `group_${parent.children[i].id}`
          ),
        ];
        if (parent.children[i + 1]) {
          row.push(Markup.button.callback(
            `${icons[(i + 1) % icons.length]} ${parent.children[i + 1].name}`,
            `group_${parent.children[i + 1].id}`
          ));
        }
        buttons.push(row);
      }
    }

    if (hasChildren && hasProducts) {
      buttons.push([Markup.button.callback('─── الخدمات المتاحة ───', 'noop')]);
    }

    directProducts.forEach(p => {
      buttons.push([Markup.button.callback(`⚡ ${p.name}`, `product_${p.id}`)]);
    });

    if (directTotal > limit) {
      buttons.push([Markup.button.callback(
        `التالي ▶️  (${directTotal - limit} خدمة أخرى)`,
        `products_page_2`
      )]);
    }

    const path = ctx.session.groupPath || [];
    if (path.length > 1) {
      buttons.push([Markup.button.callback('🔙 رجوع', `back_to_group_${path[path.length - 2]}`)]);
    } else {
      buttons.push([Markup.button.callback('🔙 رجوع للتصنيفات', 'back_to_groups')]);
    }

    ctx.session.selectedGroupId = parentId;

    const headerText =
      `📂 *${escapeMarkdown(parent.name)}*\n` +
      (hasChildren && hasProducts
        ? `\nيحتوي على تصنيفات فرعية وخدمات مباشرة:`
        : hasChildren
        ? `\nاختر التصنيف الفرعي:`
        : `\nاختر الخدمة:`);

    await ctx.editMessageText(headerText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  });

  // ── Pagination ──
  bot.action(/^products_page_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.dbUser;
    if (!user) return;

    const page    = parseInt(ctx.match[1]);
    const groupId = ctx.session.selectedGroupId;
    if (!groupId) return ctx.answerCbQuery('❌ حدث خطأ.', { show_alert: true });

    const limit = PRODUCTS_PER_PAGE;
    const skip  = (page - 1) * limit;

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where:   { groupId, isActive: true, isManual: false },
        orderBy: { sortOrder: 'asc' },
        skip,
        take:    limit,
      }),
      prisma.product.count({ where: { groupId, isActive: true, isManual: false } }),
    ]);

    if (products.length === 0) return ctx.answerCbQuery('لا توجد منتجات', { show_alert: true });

    const totalPages = Math.ceil(total / limit);
    ctx.session.productsPage = page;

    const group   = await prisma.productGroup.findUnique({ where: { id: groupId } });
    const buttons = [];

    products.forEach(p => {
      buttons.push([Markup.button.callback(`⚡ ${p.name}`, `product_${p.id}`)]);
    });

    const navRow = [];
    if (page > 1)          navRow.push(Markup.button.callback('◀️ السابق', `products_page_${page - 1}`));
    navRow.push(Markup.button.callback(`📄 ${page}/${totalPages}`, 'noop'));
    if (page < totalPages) navRow.push(Markup.button.callback('التالي ▶️', `products_page_${page + 1}`));
    if (navRow.length > 1) buttons.push(navRow);

    buttons.push([Markup.button.callback('🔙 رجوع', `group_${groupId}`)]);

    await ctx.editMessageText(
      `📂 *${escapeMarkdown(group?.name || '')}*  —  صفحة ${page} من ${totalPages}:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  });

  // ── اختيار منتج ──
  bot.action(/^product_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.dbUser;
    if (!user) return;

    const productId = parseInt(ctx.match[1]);
    const product   = await prisma.product.findUnique({
      where: { id: productId }, include: { group: true },
    });

    if (!product || !product.isActive) {
      return ctx.answerCbQuery('❌ الخدمة غير متاحة حالياً', { show_alert: true });
    }

    const fresh        = await userSvc.getUserById(user.id);
    const settings     = await settingsSvc.getAllSettings();
    const rate         = parseFloat(settings.exchange_rate || '3.75');
    const margin       = parseFloat(settings.profit_margin || '0.20');
    const discount     = await getVipDiscount(fresh.vipLevel, settings);
    const pricePerUnit = parseFloat(product.priceUsd) * (1 + margin) * (1 - discount);
    const pricePer1000 = (pricePerUnit * 1000 * rate).toFixed(4);
    const discountStr  = discount > 0
      ? `\n✨ خصم VIP: \`${(discount * 100).toFixed(0)}%\`` : '';

    ctx.session.selectedProductId = productId;
    ctx.session.step              = 'auto_quantity';

    await ctx.editMessageText(
      `📦 *${escapeMarkdown(product.name)}*\n` +
      `📂 ${escapeMarkdown(product.group?.name || '')}\n\n` +
      `💰 السعر لكل 1000: \`${pricePer1000}\`` + discountStr + `\n` +
      `📉 الحد الأدنى: \`${product.minQuantity}\`\n` +
      `📈 الحد الأقصى: \`${product.maxQuantity}\`\n` +
      (product.description ? `📋 ${escapeMarkdown(product.description)}\n` : '') +
      `\n💵 رصيدك: \`${formatBalance(fresh.balance)}$\`\n\n` +
      `✏️ أدخل الكمية:`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // ⚙️ MANUAL SERVICE
  // ──────────────────────────────────────
  bot.hears('⚙️ شحن يدوي', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');

    const products = await prisma.product.findMany({
      where:   { isActive: true, isManual: true },
      include: { group: true },
      orderBy: { sortOrder: 'asc' },
    });

    if (products.length === 0) return safeReply(ctx, '❌ لا توجد خدمات يدوية متاحة حالياً.');

    const buttons = products.map(p => [
      Markup.button.callback(
        `⚙️ ${p.group?.name ? p.group.name + ' — ' : ''}${p.name}`,
        `manual_product_${p.id}`
      ),
    ]);
    buttons.push([Markup.button.callback('❌ إلغاء', 'cancel')]);

    await safeReply(ctx,
      `⚙️ *الشحن اليدوي*\n\nاختر الخدمة:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  });

  bot.action(/^manual_product_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.dbUser;
    if (!user) return;
    const productId = parseInt(ctx.match[1]);
    const product   = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || !product.isActive) {
      return ctx.answerCbQuery('❌ المنتج غير متاح', { show_alert: true });
    }
    const fresh      = await userSvc.getUserById(user.id);
    const settings   = await settingsSvc.getAllSettings();
    const rate       = parseFloat(settings.exchange_rate || '3.75');
    const priceLocal = (parseFloat(product.priceUsd) * rate).toFixed(4);

    ctx.session.selectedManualProductId = productId;
    ctx.session.step = 'manual_quantity';

    await ctx.editMessageText(
      `⚙️ *${escapeMarkdown(product.name)}*\n\n` +
      `💰 السعر للوحدة: \`${priceLocal}\`\n` +
      `📉 الحد الأدنى: \`${product.minQuantity}\`\n` +
      `📈 الحد الأقصى: \`${product.maxQuantity}\`\n\n` +
      `💵 رصيدك: \`${formatBalance(fresh.balance)}$\`\n\n` +
      `✏️ أدخل الكمية:`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // 📊 TRANSACTIONS
  // ──────────────────────────────────────
  bot.hears('📊 معاملاتي', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    await safeReply(ctx,
      `📊 *سجل المعاملات*\n\nاختر نوع السجل:`,
      { parse_mode: 'Markdown', ...keyboards.transactionsMenu() }
    );
  });

  bot.hears('📥 سجل الإيداعات', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const { deposits, total } = await depositSvc.getDeposits({ userId: user.id, page: 1, limit: 5 });
    if (deposits.length === 0) return safeReply(ctx, '📭 لا توجد إيداعات بعد.');

    let msg = `📥 *آخر الإيداعات*\n\n`;
    for (const d of deposits) {
      const emoji  = { PENDING: '⏳', APPROVED: '✅', REJECTED: '❌' }[d.status] || '❓';
      const status = { PENDING: 'معلق', APPROVED: 'مقبول', REJECTED: 'مرفوض' }[d.status] || d.status;
      msg += `${emoji} \`${parseFloat(d.amountUsd).toFixed(2)}$\`  •  ${d.method?.name || ''}  •  ${status}\n`;
      msg += `   📅 ${new Date(d.createdAt).toLocaleDateString('ar')}\n\n`;
    }
    msg += `📊 الإجمالي: *${total}* معاملة`;
    await safeReply(ctx, msg, { parse_mode: 'Markdown' });
  });

  bot.hears('📤 سجل السحوبات', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const { withdrawals, total } = await withdrawSvc.getWithdrawals({ userId: user.id, page: 1, limit: 5 });
    if (withdrawals.length === 0) return safeReply(ctx, '📭 لا توجد سحوبات بعد.');

    let msg = `📤 *آخر السحوبات*\n\n`;
    for (const w of withdrawals) {
      const emoji  = { PENDING: '⏳', APPROVED: '🔄', COMPLETED: '✅', REJECTED: '❌' }[w.status] || '❓';
      const status = { PENDING: 'معلق', APPROVED: 'مقبول', COMPLETED: 'مكتمل', REJECTED: 'مرفوض' }[w.status] || w.status;
      const rate   = parseFloat(w.method?.exchangeRate) || 1;
      const local  = rate !== 1 ? `  ≈ ${(parseFloat(w.netAmount) * rate).toFixed(2)} محلي` : '';
      msg += `${emoji} \`${parseFloat(w.netAmount).toFixed(2)}$\`${local}  •  ${status}\n`;
      msg += `   🏦 ${w.method?.name || ''}  •  📅 ${new Date(w.createdAt).toLocaleDateString('ar')}\n\n`;
    }
    msg += `📊 الإجمالي: *${total}* معاملة`;
    await safeReply(ctx, msg, { parse_mode: 'Markdown' });
  });

  bot.hears('📦 سجل الطلبات', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const { orders, total } = await orderSvc.getOrders({ userId: user.id, page: 1, limit: 5 });
    if (orders.length === 0) return safeReply(ctx, '📭 لا توجد طلبات بعد.');

    let msg = `📦 *آخر الطلبات*\n\n`;
    for (const o of orders) {
      const emoji  = { PENDING: '⏳', PROCESSING: '🔄', COMPLETED: '✅', PARTIAL: '⚠️', CANCELLED: '🚫', FAILED: '❌' }[o.status] || '❓';
      const status = { PENDING: 'معلق', PROCESSING: 'قيد التنفيذ', COMPLETED: 'مكتمل', PARTIAL: 'جزئي', CANCELLED: 'ملغى', FAILED: 'فشل' }[o.status] || o.status;
      msg += `${emoji} *#${o.id}*  ${escapeMarkdown(o.product?.name || '')}\n`;
      msg += `   \`${parseFloat(o.totalPrice).toFixed(2)}$\`  •  🔢 ${o.quantity}  •  ${status}\n\n`;
    }
    msg += `📊 الإجمالي: *${total}* طلب`;
    await safeReply(ctx, msg, { parse_mode: 'Markdown' });
  });

  bot.hears('⏳ الطلبات النشطة', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const { orders } = await orderSvc.getOrders({ userId: user.id, status: 'PROCESSING', limit: 10 });
    if (orders.length === 0) {
      return safeReply(ctx, `✅ *لا توجد طلبات نشطة*\n\nجميع طلباتك مكتملة 🎉`, { parse_mode: 'Markdown' });
    }
    let msg = `⏳ *الطلبات النشطة*\n\n`;
    for (const o of orders) {
      msg += `🔄 *#${o.id}*  ${escapeMarkdown(o.product?.name || '')}\n`;
      msg += `   🔢 الكمية: ${o.quantity}  •  المتبقي: ${o.remains ?? '—'}\n\n`;
    }
    await safeReply(ctx, msg, { parse_mode: 'Markdown' });
  });

  // ──────────────────────────────────────
  // 👥 REFERRAL
  // ──────────────────────────────────────
  bot.hears('👥 الإحالة', async (ctx) => {
    const user  = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const stats = await referralSvc.getReferralStats(user.id);
    const link  = `https://t.me/${config.bot.username}?start=ref_${user.referralCode}`;
    await safeReply(ctx,
      `👥 *نظام الإحالة*\n\n` +
      `🔗 رابطك الخاص:\n\`${link}\`\n\n` +
      `👤 المدعوون: \`${stats.invitedCount}\` شخص\n` +
      `📦 طلباتهم: \`${stats.totalOrders}\` طلب\n` +
      `💰 عمولاتك: \`${stats.totalCommission.toFixed(2)}$\`\n\n` +
      `_💡 احصل على عمولة على كل طلب يقوم به المدعوون!_`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // 🎧 SUPPORT
  // ──────────────────────────────────────
  bot.hears('🎧 الدعم الفني', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const minLength = parseInt(await settingsSvc.getSetting('support_min_length') || '20');
    ctx.session.step = 'support_message';
    await safeReply(ctx,
      `🎧 *الدعم الفني*\n\n📝 أرسل رسالتك وسيتم الرد في أقرب وقت\n_الحد الأدنى: ${minLength} حرف_`,
      { parse_mode: 'Markdown', ...keyboards.cancelButton() }
    );
  });

  // ──────────────────────────────────────
  // 🔧 BOT SYSTEMS
  // ──────────────────────────────────────
  bot.hears('🔧 أنظمة البوت', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const settings = await settingsSvc.getAllSettings();
    await safeReply(ctx,
      `🔧 *معلومات النظام*\n\n` +
      `💱 سعر الصرف: \`${settings.exchange_rate || '3.75'}\`\n` +
      `📊 هامش الربح: \`${((parseFloat(settings.profit_margin || '0.20')) * 100).toFixed(0)}%\`\n` +
      `🔧 الصيانة: ${settings.maintenance_mode === 'true' ? '🔴 مفعّل' : '🟢 غير مفعّل'}\n` +
      `📢 التحقق من القناة: ${settings.channel_verification === 'true' ? '🟢 مفعّل' : '⚪ غير مفعّل'}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // 📢 ANNOUNCEMENTS
  // ──────────────────────────────────────
  bot.hears('📢 الإعلانات', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return safeReply(ctx, '❌ أرسل /start أولاً');
    const latest = await prisma.broadcastLog.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!latest) return safeReply(ctx, '📭 لا توجد إعلانات حالياً.');
    await safeReply(ctx,
      `📢 *آخر إعلان*\n\n${latest.message}\n\n_📅 ${new Date(latest.createdAt).toLocaleDateString('ar')}_`,
      { parse_mode: 'Markdown' }
    );
  });

  // ──────────────────────────────────────
  // ❌ CANCEL
  // ──────────────────────────────────────
  bot.hears('❌ إلغاء', async (ctx) => {
    const user = ctx.dbUser;
    ctx.session.step                    = null;
    ctx.session.depositMethodId         = null;
    ctx.session.withdrawMethodId        = null;
    ctx.session.selectedProductId       = null;
    ctx.session.selectedManualProductId = null;
    ctx.session.transferTargetId        = null;
    ctx.session.autoQuantity            = null;
    ctx.session.autoLink                = null;
    ctx.session.groupPath               = [];
    ctx.session.selectedGroupId         = null;
    await safeReply(ctx, '❌ تم الإلغاء.', user ? keyboards.mainMenu(user) : {});
  });

  bot.action('cancel', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = null;
    await ctx.editMessageText('❌ تم الإلغاء.').catch(() => {});
  });

  // ──────────────────────────────────────
  // ADMIN CALLBACKS — DEPOSIT
  // ──────────────────────────────────────
  bot.action(/^deposit_approve_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!userSvc.isAdminUser(ctx.from.id)) return;
    const depositId = parseInt(ctx.match[1]);
    try {
      await depositSvc.approveDeposit(depositId, null);
      await ctx.editMessageText(`✅ تمت الموافقة على الإيداع #${depositId}`);
      const fullDeposit = await prisma.deposit.findUnique({
        where: { id: depositId }, include: { user: true },
      });
      await notifySvc.notifyUserDepositApproved(
        fullDeposit?.user?.telegramId, fullDeposit?.amountUsd
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
      await depositSvc.rejectDeposit(depositId);
      await ctx.editMessageText(`❌ تم رفض الإيداع #${depositId}`);
      const fullDeposit = await prisma.deposit.findUnique({
        where: { id: depositId }, include: { user: true },
      });
      await notifySvc.notifyUserDepositRejected(fullDeposit?.user?.telegramId).catch(() => {});
    } catch (err) {
      await ctx.answerCbQuery(`❌ ${err.message}`, { show_alert: true });
    }
  });

  // ──────────────────────────────────────
  // ADMIN CALLBACKS — WITHDRAWAL
  // ──────────────────────────────────────
  bot.action(/^withdraw_approve_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!userSvc.isAdminUser(ctx.from.id)) return;
    const wId = parseInt(ctx.match[1]);
    try {
      await withdrawSvc.approveWithdrawal(wId);
      await ctx.editMessageText(`✅ تمت الموافقة على السحب #${wId}`);
      const w = await prisma.withdrawal.findUnique({
        where: { id: wId }, include: { user: true, method: true },
      });
      await notifySvc.notifyUserWithdrawalApproved(w?.user?.telegramId, w, w?.method).catch(() => {});
    } catch (err) {
      await ctx.answerCbQuery(`❌ ${err.message}`, { show_alert: true });
    }
  });

  bot.action(/^withdraw_reject_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!userSvc.isAdminUser(ctx.from.id)) return;
    const wId = parseInt(ctx.match[1]);
    try {
      const w = await prisma.withdrawal.findUnique({
        where: { id: wId }, include: { user: true, method: true },
      });
      await withdrawSvc.rejectWithdrawal(wId, 'رفض من المدير');
      await ctx.editMessageText(`❌ تم رفض السحب #${wId}`);
      await notifySvc.notifyUserWithdrawalRejected(w?.user?.telegramId, w, 'رفض من المدير').catch(() => {});
    } catch (err) {
      await ctx.answerCbQuery(`❌ ${err.message}`, { show_alert: true });
    }
  });

  // ──────────────────────────────────────
  // NOOP
  // ──────────────────────────────────────
  bot.action('noop', (ctx) => ctx.answerCbQuery());

  // ══════════════════════════════════════
  // TEXT MESSAGE HANDLER
  // ══════════════════════════════════════
  bot.on('text', async (ctx) => {
    const step = ctx.session?.step;
    const text = ctx.message.text.trim();
    const user = ctx.dbUser;
    if (!step || !user) return;

    // ── DEPOSIT: amount ──
    if (step === 'deposit_amount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) return safeReply(ctx, '❌ أدخل مبلغاً صحيحاً');
      ctx.session.depositAmount = amount;
      ctx.session.step = 'deposit_txid';
      return safeReply(ctx,
        `✅ المبلغ: \`${amount}\`\n\n📋 أدخل رقم المعاملة (Transaction ID):`,
        { parse_mode: 'Markdown', ...keyboards.cancelButton() }
      );
    }

    // ── DEPOSIT: transaction ID ──
    if (step === 'deposit_txid') {
      try {
        const amount = ctx.session.depositAmount;
        await depositSvc.createDeposit(user.id, ctx.session.depositMethodId, amount, text);
        ctx.session.step            = null;
        ctx.session.depositMethodId = null;
        ctx.session.depositAmount   = null;
        await safeReply(ctx,
          `✅ *تم إرسال طلب الإيداع*\n\n💰 المبلغ: \`${amount}\`\n🔢 رقم المعاملة: \`${text}\`\n\n⏳ _بانتظار موافقة المدير..._`,
          { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
        );
      } catch (err) {
        await safeReply(ctx, `❌ ${err.message}`);
      }
      return;
    }

    // ── WITHDRAW: amount ──
    if (step === 'withdraw_amount') {
      const amountUsd = parseFloat(text);
      if (isNaN(amountUsd) || amountUsd <= 0) {
        return safeReply(ctx, '❌ أدخل مبلغاً صحيحاً بالدولار');
      }
      const method = await prisma.withdrawMethod.findUnique({
        where: { id: ctx.session.withdrawMethodId },
      });
      if (!method) return safeReply(ctx, '❌ الطريقة غير موجودة');

      const minUsd = parseFloat(method.minAmount);
      const maxUsd = parseFloat(method.maxAmount);
      if (amountUsd < minUsd) return safeReply(ctx, `❌ الحد الأدنى للسحب هو \`${minUsd}$\``);
      if (amountUsd > maxUsd) return safeReply(ctx, `❌ الحد الأقصى للسحب هو \`${maxUsd}$\``);

      const { fee, netAmount } = withdrawSvc.calculateFee(method, amountUsd);
      const exchangeRate       = parseFloat(method.exchangeRate) || 1;
      const isLocal            = exchangeRate !== 1;
      const netAmountLocal     = withdrawSvc.calculateLocalAmount(netAmount, exchangeRate);

      ctx.session.withdrawAmount = amountUsd;
      ctx.session.step = 'withdraw_account';

      return safeReply(ctx,
        `💸 *ملخص السحب*\n\n` +
        `💰 المبلغ: \`${amountUsd}$\`\n` +
        `💳 الرسوم: \`${fee}$\`\n` +
        `✅ الصافي: \`${netAmount}$\`` +
        (isLocal ? `\n💵 بالعملة المحلية: \`${netAmountLocal.toFixed(2)}\`` : '') +
        `\n\n📋 أدخل معلومات حسابك للاستلام:`,
        { parse_mode: 'Markdown', ...keyboards.cancelButton() }
      );
    }

    // ── WITHDRAW: account info ──
    if (step === 'withdraw_account') {
      try {
        const freshUser  = await userSvc.getUserById(user.id);
        const method     = await prisma.withdrawMethod.findUnique({
          where: { id: ctx.session.withdrawMethodId },
        });
        const result = await withdrawSvc.createWithdrawal(
          user.id, ctx.session.withdrawMethodId, ctx.session.withdrawAmount, text
        );
        await notifySvc.notifyAdminsWithdrawal(result, freshUser, method).catch(() => {});

        const exchangeRate = parseFloat(method?.exchangeRate) || 1;
        const isLocal      = exchangeRate !== 1;
        const netLocal     = isLocal
          ? withdrawSvc.calculateLocalAmount(result.netAmount, exchangeRate)
          : null;

        const withdrawAmount = ctx.session.withdrawAmount;
        ctx.session.step             = null;
        ctx.session.withdrawMethodId = null;
        ctx.session.withdrawAmount   = null;

        await safeReply(ctx,
          `✅ *تم إرسال طلب السحب*\n\n` +
          `💰 المبلغ: \`${withdrawAmount}$\`\n` +
          `✅ الصافي: \`${parseFloat(result.netAmount).toFixed(2)}$\`` +
          (isLocal && netLocal ? `\n💵 بالعملة المحلية: \`${netLocal.toFixed(2)}\`` : '') +
          `\n\n⏳ _بانتظار المعالجة..._`,
          { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
        );
      } catch (err) {
        await safeReply(ctx, `❌ ${err.message}`);
      }
      return;
    }

    // ── TRANSFER: find user ──
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
      if (!target)               return safeReply(ctx, '❌ المستخدم غير موجود');
      if (target.id === user.id) return safeReply(ctx, '❌ لا يمكن التحويل لنفسك');
      if (target.isBanned)       return safeReply(ctx, '❌ هذا الحساب محظور');
      ctx.session.transferTargetId = target.id;
      ctx.session.step = 'transfer_amount';
      return safeReply(ctx,
        `👤 المستلم: *${escapeMarkdown(target.firstName)}*\n🆔 ID: \`${target.id}\`\n\n✏️ أدخل المبلغ بالدولار:`,
        { parse_mode: 'Markdown', ...keyboards.cancelButton() }
      );
    }

    // ── TRANSFER: amount ──
    if (step === 'transfer_amount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) return safeReply(ctx, '❌ أدخل مبلغاً صحيحاً');
      try {
        await walletSvc.transferBalance(user.id, ctx.session.transferTargetId, amount);
        const target = await userSvc.getUserById(ctx.session.transferTargetId);
        ctx.session.step             = null;
        ctx.session.transferTargetId = null;
        await safeReply(ctx,
          `✅ *تم التحويل بنجاح*\n\n💰 المبلغ: \`${amount}$\`\n👤 إلى: ${escapeMarkdown(target.firstName)}`,
          { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
        );
      } catch (err) {
        await safeReply(ctx, `❌ ${err.message}`);
      }
      return;
    }

    // ── AUTO SERVICE: quantity ──
    if (step === 'auto_quantity') {
      const qty = parseInt(text);
      if (isNaN(qty) || qty <= 0) return safeReply(ctx, '❌ أدخل كمية صحيحة');
      const product = await prisma.product.findUnique({ where: { id: ctx.session.selectedProductId } });
      if (!product) return safeReply(ctx, '❌ الخدمة غير موجودة. ابدأ من جديد.');
      if (qty < product.minQuantity) return safeReply(ctx, `❌ الحد الأدنى للكمية هو \`${product.minQuantity}\``);
      if (qty > product.maxQuantity) return safeReply(ctx, `❌ الحد الأقصى للكمية هو \`${product.maxQuantity}\``);
      ctx.session.autoQuantity = qty;
      ctx.session.step = 'auto_link';
      return safeReply(ctx,
        `✅ الكمية: \`${qty}\`\n\n🔗 أدخل رابط الحساب أو معرّف اللاعب:`,
        { parse_mode: 'Markdown', ...keyboards.cancelButton() }
      );
    }

    // ── AUTO SERVICE: link ──
    if (step === 'auto_link') {
      const link      = text;
      const productId = ctx.session.selectedProductId;
      const quantity  = ctx.session.autoQuantity;
      ctx.session.autoLink = link;
      ctx.session.step     = 'auto_confirm';

      const product = await prisma.product.findUnique({
        where: { id: productId }, include: { group: true },
      });
      if (!product) {
        ctx.session.step = null;
        return safeReply(ctx, '❌ الخدمة غير موجودة.', keyboards.mainMenu(user));
      }

      const settings     = await settingsSvc.getAllSettings();
      const rate         = parseFloat(settings.exchange_rate || '3.75');
      const margin       = parseFloat(settings.profit_margin || '0.20');
      const discount     = await getVipDiscount(user.vipLevel, settings);
      const pricePerUnit = parseFloat(product.priceUsd) * (1 + margin) * (1 - discount);
      const totalLocal   = (pricePerUnit * quantity * rate).toFixed(4);
      const isDuplicate  = await orderSvc.checkDuplicateOrder(user.id, productId);
      const freshUser    = await userSvc.getUserById(user.id);

      return safeReply(ctx,
        (isDuplicate ? `⚠️ *تحذير: لديك طلب مماثل في آخر 5 دقائق!*\n\n` : '') +
        `📋 *تأكيد الطلب*\n\n` +
        `📦 الخدمة: ${escapeMarkdown(product.name)}\n` +
        `📂 التصنيف: ${escapeMarkdown(product.group?.name || '')}\n` +
        `🔢 الكمية: \`${quantity}\`\n` +
        `🔗 الرابط/المعرّف: \`${link}\`\n\n` +
        `💰 الإجمالي: \`${totalLocal}$\`\n` +
        `💵 رصيدك: \`${formatBalance(freshUser.balance)}$\`\n\n` +
        (isDuplicate ? `هل تريد المتابعة رغم ذلك؟` : `هل تريد تأكيد الطلب؟`),
        { parse_mode: 'Markdown', ...keyboards.confirmCancel() }
      );
    }

    // ── AUTO SERVICE: confirm ──
    if (step === 'auto_confirm') {
      if (text === '✅ تأكيد') {
        try {
          const order = await orderSvc.createAutoOrder(
            user.id, ctx.session.selectedProductId,
            ctx.session.autoQuantity, ctx.session.autoLink
          );
          ctx.session.step              = null;
          ctx.session.selectedProductId = null;
          ctx.session.autoQuantity      = null;
          ctx.session.autoLink          = null;
          await safeReply(ctx,
            `✅ *تم إنشاء الطلب بنجاح*\n\n🆔 رقم الطلبية: \`#${order.id}\`\n\n⏳ _سنُرسل لك إشعاراً عند الانتهاء_`,
            { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
          );
        } catch (err) {
          await safeReply(ctx, `❌ ${err.message}`);
        }
      } else {
        ctx.session.step = null;
        await safeReply(ctx, '❌ تم إلغاء الطلب.', keyboards.mainMenu(user));
      }
      return;
    }

    // ── MANUAL SERVICE: quantity ──
    if (step === 'manual_quantity') {
      const qty = parseInt(text);
      if (isNaN(qty) || qty <= 0) return safeReply(ctx, '❌ أدخل كمية صحيحة');
      const product = await prisma.product.findUnique({ where: { id: ctx.session.selectedManualProductId } });
      if (!product) return safeReply(ctx, '❌ المنتج غير موجود.');
      if (qty < product.minQuantity) return safeReply(ctx, `❌ الحد الأدنى للكمية هو \`${product.minQuantity}\``);
      if (qty > product.maxQuantity) return safeReply(ctx, `❌ الحد الأقصى للكمية هو \`${product.maxQuantity}\``);
      ctx.session.manualQuantity = qty;
      ctx.session.step = 'manual_account';
      return safeReply(ctx,
        `✅ الكمية: \`${qty}\`\n\n📋 أدخل معلومات الحساب:`,
        { parse_mode: 'Markdown', ...keyboards.cancelButton() }
      );
    }

    // ── MANUAL SERVICE: account info ──
    if (step === 'manual_account') {
      ctx.session.manualAccountInfo = text;
      ctx.session.step = 'manual_confirm';
      const product = await prisma.product.findUnique({ where: { id: ctx.session.selectedManualProductId } });
      if (!product) {
        ctx.session.step = null;
        return safeReply(ctx, '❌ المنتج غير موجود.', keyboards.mainMenu(user));
      }
      const settings = await settingsSvc.getAllSettings();
      const rate     = parseFloat(settings.exchange_rate || '3.75');
      const total    = (parseFloat(product.priceUsd) * ctx.session.manualQuantity * rate).toFixed(4);
      return safeReply(ctx,
        `📋 *تأكيد الطلب اليدوي*\n\n` +
        `📦 الخدمة: ${escapeMarkdown(product.name)}\n` +
        `🔢 الكمية: \`${ctx.session.manualQuantity}\`\n` +
        `📋 الحساب: \`${text}\`\n\n` +
        `💰 الإجمالي: \`${total}$\`\n\n` +
        `هل تريد تأكيد الطلب؟`,
        { parse_mode: 'Markdown', ...keyboards.confirmCancel() }
      );
    }

    // ── MANUAL SERVICE: confirm ──
    if (step === 'manual_confirm') {
      if (text === '✅ تأكيد') {
        try {
          const order = await orderSvc.createManualOrder(
            user.id, ctx.session.selectedManualProductId,
            ctx.session.manualQuantity, ctx.session.manualAccountInfo
          );
          ctx.session.step                    = null;
          ctx.session.selectedManualProductId = null;
          ctx.session.manualQuantity          = null;
          ctx.session.manualAccountInfo       = null;
          await safeReply(ctx,
            `✅ *تم إرسال الطلب اليدوي*\n\n🆔 رقم الطلبية: \`#${order.id}\`\n\n⏳ _بانتظار موافقة المدير..._`,
            { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
          );
        } catch (err) {
          await safeReply(ctx, `❌ ${err.message}`);
        }
      } else {
        ctx.session.step = null;
        await safeReply(ctx, '❌ تم إلغاء الطلب.', keyboards.mainMenu(user));
      }
      return;
    }

    // ── SUPPORT ──
    if (step === 'support_message') {
      const minLength = parseInt(await settingsSvc.getSetting('support_min_length') || '20');
      if (text.length < minLength) {
        return safeReply(ctx, `❌ الرسالة قصيرة جداً — الحد الأدنى ${minLength} حرف`);
      }
      const freshUser = await userSvc.getUserById(user.id);
      await prisma.supportMessage.create({ data: { userId: user.id, message: text } });
      const { bot } = require('./bot');
      await bot.telegram.sendMessage(
        config.bot.supportChannelId,
        `🎧 *رسالة دعم جديدة*\n\n` +
        `👤 ${escapeMarkdown(freshUser.firstName)}  |  🆔 \`${freshUser.id}\`\n` +
        `📱 \`${freshUser.telegramId}\`  |  💰 ${formatBalance(freshUser.balance)}$\n\n` +
        `📝 *الرسالة:*\n${text}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      ctx.session.step = null;
      await safeReply(ctx,
        `✅ *تم إرسال رسالتك*\n\n_سيتم الرد عليك في أقرب وقت ممكن_ 🙏`,
        { parse_mode: 'Markdown', ...keyboards.mainMenu(user) }
      );
      return;
    }
  });
}

module.exports = { register, notifyReferrer };
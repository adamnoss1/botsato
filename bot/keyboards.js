const { Markup } = require('telegraf');
const { getVipBadge, getVipLabel } = require('../services/vipService');

// ─────────────────────────────────────────
// MAIN MENU
// ─────────────────────────────────────────
function mainMenu(user) {
  const badge = getVipBadge(user.vipLevel);
  return Markup.keyboard([
    ['📊 معاملاتي', '💰 محفظتي'],
    ['⚡️ شحن تلقائي', '⚙️ شحن يدوي'],
    ['🎧 الدعم الفني', '📢 الإعلانات'],
    ['🔧 أنظمة البوت', '👥 الإحالة'],
  ]).resize();
}

// ─────────────────────────────────────────
// WALLET MENU
// ─────────────────────────────────────────
function walletMenu() {
  return Markup.keyboard([
    ['➕ إيداع', '➖ سحب'],
    ['↔️ تحويل رصيد', '💳 رصيدي'],
    ['🔙 القائمة الرئيسية'],
  ]).resize();
}

// ─────────────────────────────────────────
// TRANSACTIONS MENU
// ─────────────────────────────────────────
function transactionsMenu() {
  return Markup.keyboard([
    ['📥 سجل الإيداعات', '📤 سجل السحوبات'],
    ['📦 سجل الطلبات', '⏳ الطلبات النشطة'],
    ['🔙 القائمة الرئيسية'],
  ]).resize();
}

// ─────────────────────────────────────────
// BACK BUTTON
// ─────────────────────────────────────────
function backButton(label = '🔙 رجوع') {
  return Markup.keyboard([[label]]).resize();
}

// ─────────────────────────────────────────
// CANCEL BUTTON
// ─────────────────────────────────────────
function cancelButton() {
  return Markup.keyboard([['❌ إلغاء']]).resize();
}

// ─────────────────────────────────────────
// CONFIRM / CANCEL
// ─────────────────────────────────────────
function confirmCancel() {
  return Markup.keyboard([
    ['✅ تأكيد', '❌ إلغاء'],
  ]).resize();
}

// ─────────────────────────────────────────
// INLINE - CHANNEL VERIFICATION
// ─────────────────────────────────────────
function channelVerifyKeyboard(channelUsername) {
  return Markup.inlineKeyboard([
    [Markup.button.url('📢 انضم للقناة', `https://t.me/${channelUsername}`)],
    [Markup.button.callback('✅ تحقق من الاشتراك', 'verify_subscription')],
  ]);
}

// ─────────────────────────────────────────
// INLINE - DEPOSIT METHODS
// ─────────────────────────────────────────
function depositMethodsKeyboard(methods) {
  const buttons = methods.map(m => [
    Markup.button.callback(`${m.name} (1$ = ${m.exchangeRate})`, `deposit_method_${m.id}`),
  ]);
  buttons.push([Markup.button.callback('❌ إلغاء', 'cancel')]);
  return Markup.inlineKeyboard(buttons);
}

// ─────────────────────────────────────────
// INLINE - WITHDRAW METHODS
// ─────────────────────────────────────────
function withdrawMethodsKeyboard(methods) {
  const buttons = methods.map(m => [
    Markup.button.callback(`${m.name}`, `withdraw_method_${m.id}`),
  ]);
  buttons.push([Markup.button.callback('❌ إلغاء', 'cancel')]);
  return Markup.inlineKeyboard(buttons);
}

// ─────────────────────────────────────────
// INLINE - PRODUCT GROUPS (categories)
// ─────────────────────────────────────────
function productGroupsKeyboard(groups) {
  const buttons = groups.map(g => [
    Markup.button.callback(g.name, `group_${g.id}`),
  ]);
  buttons.push([Markup.button.callback('❌ إلغاء', 'cancel')]);
  return Markup.inlineKeyboard(buttons);
}

// ─────────────────────────────────────────
// INLINE - PRODUCTS LIST
// ─────────────────────────────────────────
function productsKeyboard(products, page = 1, totalPages = 1) {
  const buttons = products.map(p => [
    Markup.button.callback(
      `${p.name} - ${p.priceUsd}$`,
      `product_${p.id}`
    ),
  ]);

  const nav = [];
  if (page > 1)          nav.push(Markup.button.callback('◀️ السابق', `products_page_${page - 1}`));
  if (page < totalPages) nav.push(Markup.button.callback('التالي ▶️', `products_page_${page + 1}`));
  if (nav.length > 0) buttons.push(nav);

  buttons.push([Markup.button.callback('🔙 رجوع', 'back_to_groups')]);
  return Markup.inlineKeyboard(buttons);
}

// ─────────────────────────────────────────
// INLINE - ORDER CONFIRM
// ─────────────────────────────────────────
function orderConfirmKeyboard(orderId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ تأكيد الطلب', `confirm_order_${orderId}`),
      Markup.button.callback('❌ إلغاء', 'cancel'),
    ],
  ]);
}

// ─────────────────────────────────────────
// INLINE - PAGINATION
// ─────────────────────────────────────────
function paginationKeyboard(prefix, page, totalPages) {
  const buttons = [];
  if (page > 1)          buttons.push(Markup.button.callback('◀️', `${prefix}_${page - 1}`));
  buttons.push(Markup.button.callback(`${page}/${totalPages}`, 'noop'));
  if (page < totalPages) buttons.push(Markup.button.callback('▶️', `${prefix}_${page + 1}`));
  return Markup.inlineKeyboard([buttons]);
}

module.exports = {
  mainMenu,
  walletMenu,
  transactionsMenu,
  backButton,
  cancelButton,
  confirmCancel,
  channelVerifyKeyboard,
  depositMethodsKeyboard,
  withdrawMethodsKeyboard,
  productGroupsKeyboard,
  productsKeyboard,
  orderConfirmKeyboard,
  paginationKeyboard,
};
// bot/keyboards.js
const { Markup } = require('telegraf');
const { getVipBadge, getVipLabel } = require('../services/vipService');

// ─────────────────────────────────────────
// MAIN MENU — صفين
// ─────────────────────────────────────────
function mainMenu(user) {
  return Markup.keyboard([
    ['⚡️ شحن تلقائي',  '⚙️ شحن يدوي'   ],
    ['💰 محفظتي',      '📊 معاملاتي'    ],
    ['👥 الإحالة',     '🎧 الدعم الفني' ],
    ['📢 الإعلانات',   '🔧 أنظمة البوت' ],
  ]).resize();
}

// ─────────────────────────────────────────
// WALLET MENU — صفين
// ─────────────────────────────────────────
function walletMenu() {
  return Markup.keyboard([
    ['➕ إيداع',        '➖ سحب'         ],
    ['↔️ تحويل رصيد',  '💳 رصيدي'       ],
    ['🔙 القائمة الرئيسية'],
  ]).resize();
}

// ─────────────────────────────────────────
// TRANSACTIONS MENU — صفين
// ─────────────────────────────────────────
function transactionsMenu() {
  return Markup.keyboard([
    ['📥 سجل الإيداعات',  '📤 سجل السحوبات' ],
    ['📦 سجل الطلبات',    '⏳ الطلبات النشطة'],
    ['🔙 القائمة الرئيسية'],
  ]).resize();
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
// CHANNEL VERIFY
// ─────────────────────────────────────────
function channelVerifyKeyboard(channelUsername) {
  return Markup.inlineKeyboard([
    [Markup.button.url('📢 انضم للقناة الآن', `https://t.me/${channelUsername}`)],
    [Markup.button.callback('✅ تحققت من الاشتراك', 'verify_subscription')],
  ]);
}

// ─────────────────────────────────────────
// DEPOSIT METHODS
// ─────────────────────────────────────────
function depositMethodsKeyboard(methods) {
  const buttons = methods.map(m => [
    Markup.button.callback(
      `💳 ${m.name}  •  1$ = ${m.exchangeRate}`,
      `deposit_method_${m.id}`
    ),
  ]);
  buttons.push([Markup.button.callback('❌ إلغاء', 'cancel')]);
  return Markup.inlineKeyboard(buttons);
}

// ─────────────────────────────────────────
// WITHDRAW METHODS
// ─────────────────────────────────────────
function withdrawMethodsKeyboard(methods) {
  const buttons = methods.map(m => {
    const rate    = parseFloat(m.exchangeRate) || 1;
    const rateStr = rate !== 1 ? `  •  1$ = ${rate}` : '';
    const feeStr  = m.feeType === 'percentage'
      ? `رسوم ${(parseFloat(m.feeValue) * 100).toFixed(0)}%`
      : `رسوم ثابتة ${m.feeValue}$`;
    return [Markup.button.callback(
      `💸 ${m.name}${rateStr}  [${feeStr}]`,
      `withdraw_method_${m.id}`
    )];
  });
  buttons.push([Markup.button.callback('❌ إلغاء', 'cancel')]);
  return Markup.inlineKeyboard(buttons);
}

// ─────────────────────────────────────────
// PRODUCT GROUPS — صفين
// ─────────────────────────────────────────
function productGroupsKeyboard(groups, parentId) {
  const icons   = ['🎮','📱','💎','🎯','🔥','⭐','🎁','🏆','💻','🎪','🃏','🎲'];
  const buttons = [];

  // ترتيب في صفين
  for (let i = 0; i < groups.length; i += 2) {
    const row = [
      Markup.button.callback(
        `${icons[i % icons.length]} ${groups[i].name}`,
        `group_${groups[i].id}`
      ),
    ];
    if (groups[i + 1]) {
      row.push(Markup.button.callback(
        `${icons[(i + 1) % icons.length]} ${groups[i + 1].name}`,
        `group_${groups[i + 1].id}`
      ));
    }
    buttons.push(row);
  }

  if (parentId) {
    buttons.push([Markup.button.callback('🔙 رجوع للتصنيف السابق', `back_to_group_${parentId}`)]);
  } else {
    buttons.push([Markup.button.callback('❌ إلغاء', 'cancel')]);
  }

  return Markup.inlineKeyboard(buttons);
}

// ─────────────────────────────────────────
// PRODUCTS LIST — صف واحد لكل منتج
// ─────────────────────────────────────────
function productsKeyboard(products, page, totalPages) {
  const buttons = products.map(p => [
    Markup.button.callback(`⚡ ${p.name}`, `product_${p.id}`),
  ]);

  const navRow = [];
  if (page > 1)          navRow.push(Markup.button.callback('◀️ السابق', `products_page_${page - 1}`));
  navRow.push(Markup.button.callback(`📄 ${page}/${totalPages}`, 'noop'));
  if (page < totalPages) navRow.push(Markup.button.callback('التالي ▶️', `products_page_${page + 1}`));
  if (navRow.length > 1) buttons.push(navRow);

  buttons.push([Markup.button.callback('🔙 رجوع للتصنيفات', 'back_to_groups')]);
  return Markup.inlineKeyboard(buttons);
}

// ─────────────────────────────────────────
// PAGINATION
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
  cancelButton,
  confirmCancel,
  channelVerifyKeyboard,
  depositMethodsKeyboard,
  withdrawMethodsKeyboard,
  productGroupsKeyboard,
  productsKeyboard,
  paginationKeyboard,
};
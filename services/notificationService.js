const config = require('../config/settings');

// ─────────────────────────────────────────
// GET BOT INSTANCE (lazy load to avoid circular deps)
// ─────────────────────────────────────────
function getBot() {
  try {
    const { bot } = require('../bot/bot');
    return bot;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────
// NOTIFY ADMINS - DEPOSIT
// ─────────────────────────────────────────
async function notifyAdminsDeposit(deposit) {
  const bot = getBot();
  if (!bot) return;

  const msg = `
💰 *طلب إيداع جديد*

👤 المستخدم: ${deposit.user?.firstName || 'غير معروف'}
🆔 ID: \`${deposit.userId}\`
💵 المبلغ: ${deposit.amountLocal} (${parseFloat(deposit.amountUsd).toFixed(2)}$)
🏦 الطريقة: ${deposit.method?.name || 'غير محدد'}
🔢 رقم المعاملة: \`${deposit.transactionId}\`
📅 التاريخ: ${new Date(deposit.createdAt).toLocaleString('ar')}
`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ قبول', callback_data: `deposit_approve_${deposit.id}` },
      { text: '❌ رفض',  callback_data: `deposit_reject_${deposit.id}` },
    ]],
  };

  for (const adminId of config.bot.adminTelegramIds) {
    await bot.telegram.sendMessage(adminId, msg, {
      parse_mode:   'Markdown',
      reply_markup: keyboard,
    }).catch(() => {});
  }
}

// ─────────────────────────────────────────
// NOTIFY ADMINS - WITHDRAWAL
// ─────────────────────────────────────────
async function notifyAdminsWithdrawal(withdrawal, user, method) {
  const bot = getBot();
  if (!bot) return;

  const msg = `
💸 *طلب سحب جديد*

👤 المستخدم: ${user?.firstName || 'غير معروف'}
🆔 ID: \`${withdrawal.userId}\`
💵 المبلغ: ${parseFloat(withdrawal.amount).toFixed(2)}$
💳 الرسوم: ${parseFloat(withdrawal.fee).toFixed(2)}$
✅ الصافي: ${parseFloat(withdrawal.netAmount).toFixed(2)}$
🏦 الطريقة: ${method?.name || 'غير محدد'}
📋 معلومات الحساب: \`${withdrawal.accountInfo}\`
`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ قبول',   callback_data: `withdraw_approve_${withdrawal.id}` },
      { text: '❌ رفض',    callback_data: `withdraw_reject_${withdrawal.id}` },
    ]],
  };

  for (const adminId of config.bot.adminTelegramIds) {
    await bot.telegram.sendMessage(adminId, msg, {
      parse_mode:   'Markdown',
      reply_markup: keyboard,
    }).catch(() => {});
  }
}

// ─────────────────────────────────────────
// NOTIFY ADMINS - MANUAL ORDER
// ─────────────────────────────────────────
async function notifyAdminsManualOrder(order, user, product) {
  const bot = getBot();
  if (!bot) return;

  const msg = `
⚙️ *طلب يدوي جديد*

👤 المستخدم: ${user?.firstName || 'غير معروف'}
🆔 ID: \`${order.userId}\`
📦 المنتج: ${product?.name || 'غير محدد'}
🔢 الكمية: ${order.quantity}
📋 معلومات الحساب: \`${order.accountInfo}\`
💵 الإجمالي: ${parseFloat(order.totalPrice).toFixed(2)}$
`;

  for (const adminId of config.bot.adminTelegramIds) {
    await bot.telegram.sendMessage(adminId, msg, {
      parse_mode: 'Markdown',
    }).catch(() => {});
  }
}

// ─────────────────────────────────────────
// NOTIFY USER - VIP UPGRADE
// ─────────────────────────────────────────
async function notifyUserVipUpgrade(telegramId, newLevel) {
  const bot = getBot();
  if (!bot) return;

  const labels = { BRONZE: '🥉 برونزي', SILVER: '🥈 فضي', GOLD: '🥇 ذهبي' };
  const label  = labels[newLevel] || newLevel;

  await bot.telegram.sendMessage(
    Number(telegramId),
    `🎉 تهانينا! تمت ترقيتك إلى مستوى *${label}*\nاستمتع بخصومات حصرية على جميع الخدمات!`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ─────────────────────────────────────────
// NOTIFY USER - DEPOSIT APPROVED
// ─────────────────────────────────────────
async function notifyUserDepositApproved(telegramId, amount) {
  const bot = getBot();
  if (!bot) return;

  await bot.telegram.sendMessage(
    Number(telegramId),
    `✅ تمت الموافقة على إيداعك بمبلغ *${parseFloat(amount).toFixed(2)}$*\nتم إضافة المبلغ لرصيدك.`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ─────────────────────────────────────────
// NOTIFY USER - DEPOSIT REJECTED
// ─────────────────────────────────────────
async function notifyUserDepositRejected(telegramId, reason = '') {
  const bot = getBot();
  if (!bot) return;

  await bot.telegram.sendMessage(
    Number(telegramId),
    `❌ تم رفض طلب الإيداع${reason ? `\nالسبب: ${reason}` : ''}`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

module.exports = {
  notifyAdminsDeposit,
  notifyAdminsWithdrawal,
  notifyAdminsManualOrder,
  notifyUserVipUpgrade,
  notifyUserDepositApproved,
  notifyUserDepositRejected,
};
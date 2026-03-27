// services/notificationService.js
const config = require('../config/settings');

function getBot() {
  try {
    const { bot } = require('../bot/bot');
    return bot;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────
// NOTIFY ADMINS — DEPOSIT
// ─────────────────────────────────────────
async function notifyAdminsDeposit(deposit) {
  const bot = getBot();
  if (!bot) return;

  const msg =
    `💰 *طلب إيداع جديد*\n\n` +
    `👤 المستخدم: ${deposit.user?.firstName || 'غير معروف'}\n` +
    `🆔 ID: \`${deposit.userId}\`\n` +
    `💵 المبلغ: ${deposit.amountLocal} (${parseFloat(deposit.amountUsd).toFixed(2)}$)\n` +
    `🏦 الطريقة: ${deposit.method?.name || 'غير محدد'}\n` +
    `🔢 رقم المعاملة: \`${deposit.transactionId}\`\n` +
    `📅 التاريخ: ${new Date(deposit.createdAt).toLocaleString('ar')}`;

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
// NOTIFY ADMINS — WITHDRAWAL
// ─────────────────────────────────────────
async function notifyAdminsWithdrawal(withdrawal, user, method) {
  const bot = getBot();
  if (!bot) return;

  const exchangeRate = parseFloat(method?.exchangeRate) || 1;
  const isLocal      = exchangeRate !== 1;
  const netLocal     = isLocal
    ? (parseFloat(withdrawal.netAmount) * exchangeRate).toFixed(2)
    : null;

  const msg =
    `💸 *طلب سحب جديد*\n\n` +
    `👤 المستخدم: ${user?.firstName || 'غير معروف'}\n` +
    `🆔 ID: \`${withdrawal.userId}\`\n` +
    `💵 المبلغ: ${parseFloat(withdrawal.amount).toFixed(2)}$\n` +
    `💳 الرسوم: ${parseFloat(withdrawal.fee).toFixed(2)}$\n` +
    `✅ الصافي: ${parseFloat(withdrawal.netAmount).toFixed(2)}$` +
    (isLocal && netLocal ? ` (${netLocal} بالعملة المحلية)` : '') + `\n` +
    `🏦 الطريقة: ${method?.name || 'غير محدد'}\n` +
    `📋 معلومات الحساب: \`${withdrawal.accountInfo}\``;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ قبول',  callback_data: `withdraw_approve_${withdrawal.id}` },
      { text: '❌ رفض',   callback_data: `withdraw_reject_${withdrawal.id}` },
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
// NOTIFY ADMINS — MANUAL ORDER
// ─────────────────────────────────────────
async function notifyAdminsManualOrder(order, user, product) {
  const bot = getBot();
  if (!bot) return;

  const msg =
    `⚙️ *طلب يدوي جديد*\n\n` +
    `👤 المستخدم: ${user?.firstName || 'غير معروف'}\n` +
    `🆔 ID: \`${order.userId}\`\n` +
    `📦 المنتج: ${product?.name || 'غير محدد'}\n` +
    `🔢 الكمية: ${order.quantity}\n` +
    `📋 معلومات الحساب: \`${order.accountInfo}\`\n` +
    `💵 الإجمالي: ${parseFloat(order.totalPrice).toFixed(2)}$`;

  for (const adminId of config.bot.adminTelegramIds) {
    await bot.telegram.sendMessage(adminId, msg, {
      parse_mode: 'Markdown',
    }).catch(() => {});
  }
}

// ─────────────────────────────────────────
// NOTIFY USER — DEPOSIT APPROVED
// ─────────────────────────────────────────
async function notifyUserDepositApproved(telegramId, amount) {
  const bot = getBot();
  if (!bot || !telegramId) return;

  await bot.telegram.sendMessage(
    Number(telegramId),
    `✅ *تمت الموافقة على إيداعك*\n\n` +
    `💰 المبلغ المضاف: *${parseFloat(amount).toFixed(2)}$*\n` +
    `تم إضافة المبلغ لرصيدك بنجاح.`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ─────────────────────────────────────────
// NOTIFY USER — DEPOSIT REJECTED
// ─────────────────────────────────────────
async function notifyUserDepositRejected(telegramId, reason = '') {
  const bot = getBot();
  if (!bot || !telegramId) return;

  await bot.telegram.sendMessage(
    Number(telegramId),
    `❌ *تم رفض طلب الإيداع*\n` +
    (reason ? `\nالسبب: ${reason}` : ''),
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ─────────────────────────────────────────
// NOTIFY USER — WITHDRAWAL APPROVED
// ✅ جديد
// ─────────────────────────────────────────
async function notifyUserWithdrawalApproved(telegramId, withdrawal, method) {
  const bot = getBot();
  if (!bot || !telegramId) return;

  const exchangeRate = parseFloat(method?.exchangeRate) || 1;
  const isLocal      = exchangeRate !== 1;
  const netLocal     = isLocal
    ? (parseFloat(withdrawal.netAmount) * exchangeRate).toFixed(2)
    : null;

  await bot.telegram.sendMessage(
    Number(telegramId),
    `✅ *تمت الموافقة على طلب السحب*\n\n` +
    `💰 المبلغ: *${parseFloat(withdrawal.amount).toFixed(2)}$*\n` +
    `✅ الصافي: *${parseFloat(withdrawal.netAmount).toFixed(2)}$*` +
    (isLocal && netLocal ? ` *(${netLocal} بالعملة المحلية)*` : '') + `\n` +
    `🏦 الطريقة: ${method?.name || ''}\n` +
    `⏳ سيتم تحويل المبلغ قريباً.`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ─────────────────────────────────────────
// NOTIFY USER — WITHDRAWAL COMPLETED
// ✅ جديد
// ─────────────────────────────────────────
async function notifyUserWithdrawalCompleted(telegramId, withdrawal, method) {
  const bot = getBot();
  if (!bot || !telegramId) return;

  const exchangeRate = parseFloat(method?.exchangeRate) || 1;
  const isLocal      = exchangeRate !== 1;
  const netLocal     = isLocal
    ? (parseFloat(withdrawal.netAmount) * exchangeRate).toFixed(2)
    : null;

  await bot.telegram.sendMessage(
    Number(telegramId),
    `✅ *تم إكمال طلب السحب بنجاح*\n\n` +
    `💰 المبلغ المُحوَّل: *${parseFloat(withdrawal.netAmount).toFixed(2)}$*` +
    (isLocal && netLocal ? ` *(${netLocal} بالعملة المحلية)*` : '') + `\n` +
    `🏦 الطريقة: ${method?.name || ''}\n` +
    `شكراً لاستخدامك خدماتنا! 🙏`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ─────────────────────────────────────────
// NOTIFY USER — WITHDRAWAL REJECTED
// ✅ جديد
// ─────────────────────────────────────────
async function notifyUserWithdrawalRejected(telegramId, withdrawal, reason = '') {
  const bot = getBot();
  if (!bot || !telegramId) return;

  await bot.telegram.sendMessage(
    Number(telegramId),
    `❌ *تم رفض طلب السحب*\n\n` +
    `💰 المبلغ: *${parseFloat(withdrawal.amount).toFixed(2)}$*\n` +
    `💚 تم إعادة المبلغ لرصيدك.\n` +
    (reason ? `\nالسبب: ${reason}` : ''),
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ─────────────────────────────────────────
// NOTIFY USER — VIP UPGRADE
// ─────────────────────────────────────────
async function notifyUserVipUpgrade(telegramId, newLevel) {
  const bot = getBot();
  if (!bot || !telegramId) return;

  const labels = { BRONZE: '🥉 برونزي', SILVER: '🥈 فضي', GOLD: '🥇 ذهبي' };
  const label  = labels[newLevel] || newLevel;

  await bot.telegram.sendMessage(
    Number(telegramId),
    `🎉 *تهانينا! تمت ترقيتك إلى مستوى ${label}*\n\nاستمتع بخصومات حصرية على جميع الخدمات!`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

module.exports = {
  notifyAdminsDeposit,
  notifyAdminsWithdrawal,
  notifyAdminsManualOrder,
  notifyUserDepositApproved,
  notifyUserDepositRejected,
  notifyUserWithdrawalApproved,
  notifyUserWithdrawalCompleted,
  notifyUserWithdrawalRejected,
  notifyUserVipUpgrade,
};
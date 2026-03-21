const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function determineVipLevel(totalDeposited) {
  const { getSetting } = require('./settingsService');
  const goldThreshold   = parseFloat(await getSetting('vip_gold_threshold')   || '2000');
  const silverThreshold = parseFloat(await getSetting('vip_silver_threshold') || '500');
  const bronzeThreshold = parseFloat(await getSetting('vip_bronze_threshold') || '100');
  const amount = parseFloat(totalDeposited);
  if (amount >= goldThreshold)   return 'GOLD';
  if (amount >= silverThreshold) return 'SILVER';
  if (amount >= bronzeThreshold) return 'BRONZE';
  return 'NORMAL';
}

async function updateVipLevel(userId) {
  const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
  if (!user) return;
  const newLevel = await determineVipLevel(user.totalDeposited);
  if (newLevel !== user.vipLevel) {
    await prisma.user.update({
      where: { id: user.id },
      data:  { vipLevel: newLevel },
    });
    try {
      const { notifyUserVipUpgrade } = require('./notificationService');
      await notifyUserVipUpgrade(user.telegramId, newLevel);
    } catch (_) {}
    return newLevel;
  }
  return user.vipLevel;
}

function getVipBadge(level) {
  const badges = { NORMAL: '👤', BRONZE: '🥉', SILVER: '🥈', GOLD: '🥇' };
  return badges[level] || '👤';
}

function getVipLabel(level) {
  const labels = { NORMAL: 'عادي', BRONZE: 'برونزي', SILVER: 'فضي', GOLD: 'ذهبي' };
  return labels[level] || 'عادي';
}

module.exports = { determineVipLevel, updateVipLevel, getVipBadge, getVipLabel };
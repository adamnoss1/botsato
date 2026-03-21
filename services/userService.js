const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const crypto = require('crypto');

// ─────────────────────────────────────────
// GENERATE REFERRAL CODE
// ─────────────────────────────────────────
function generateReferralCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ─────────────────────────────────────────
// FIND OR CREATE USER - مع حماية من race condition
// ─────────────────────────────────────────
async function findOrCreateUser(telegramUser, referralCode = null) {
  const telegramId = BigInt(telegramUser.id);

  // ── أولاً: حاول الإيجاد ──
  let user = await prisma.user.findUnique({ where: { telegramId } });

  if (user) {
    // تحديث بيانات المستخدم
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        firstName:  telegramUser.first_name || user.firstName,
        lastName:   telegramUser.last_name  || null,
        username:   telegramUser.username   || null,
        lastSeenAt: new Date(),
      },
    });
    return { user, isNew: false };
  }

  // ── البحث عن المُحيل ──
  let referredById = null;
  if (referralCode) {
    const referrer = await prisma.user.findUnique({
      where: { referralCode: referralCode.toUpperCase() },
    });
    if (referrer) referredById = referrer.id;
  }

  // ── توليد referral code فريد ──
  let newCode = generateReferralCode();
  let attempts = 0;
  while (attempts < 10) {
    const existing = await prisma.user.findUnique({ where: { referralCode: newCode } });
    if (!existing) break;
    newCode = generateReferralCode();
    attempts++;
  }

  // ── إنشاء المستخدم مع حماية من race condition ──
  try {
    user = await prisma.user.create({
      data: {
        telegramId,
        firstName:    telegramUser.first_name || 'User',
        lastName:     telegramUser.last_name  || null,
        username:     telegramUser.username   || null,
        referralCode: newCode,
        referredById,
        lastSeenAt:   new Date(),
      },
    });
    return { user, isNew: true, referredById };

  } catch (err) {
    // P2002 = Unique constraint violation (race condition)
    // المستخدم أُنشئ بواسطة طلب آخر في نفس اللحظة
    if (err.code === 'P2002') {
      user = await prisma.user.findUnique({ where: { telegramId } });
      if (user) return { user, isNew: false };
    }
    throw err;
  }
}

// ─────────────────────────────────────────
// GET USER BY TELEGRAM ID
// ─────────────────────────────────────────
async function getUserByTelegramId(telegramId) {
  return prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
  });
}

// ─────────────────────────────────────────
// GET USER BY ID
// ─────────────────────────────────────────
async function getUserById(id) {
  return prisma.user.findUnique({ where: { id: parseInt(id) } });
}

// ─────────────────────────────────────────
// GET USER BY REFERRAL CODE
// ─────────────────────────────────────────
async function getUserByReferralCode(code) {
  return prisma.user.findUnique({
    where: { referralCode: code.toUpperCase() },
  });
}

// ─────────────────────────────────────────
// UPDATE USER
// ─────────────────────────────────────────
async function updateUser(id, data) {
  return prisma.user.update({
    where: { id: parseInt(id) },
    data,
  });
}

// ─────────────────────────────────────────
// BAN / UNBAN
// ─────────────────────────────────────────
async function banUser(id, reason = null) {
  return prisma.user.update({
    where: { id: parseInt(id) },
    data:  { isBanned: true, banReason: reason },
  });
}

async function unbanUser(id) {
  return prisma.user.update({
    where: { id: parseInt(id) },
    data:  { isBanned: false, banReason: null },
  });
}

// ─────────────────────────────────────────
// LIST USERS (paginated)
// ─────────────────────────────────────────
async function listUsers({ page = 1, limit = 30, search = '', banned = null } = {}) {
  const skip  = (page - 1) * limit;
  const where = {};

  if (search) {
    where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { username:  { contains: search, mode: 'insensitive' } },
      { referralCode: { contains: search.toUpperCase() } },
    ];
    const numericId = parseInt(search);
    if (!isNaN(numericId)) where.OR.push({ id: numericId });
  }

  if (banned !== null) where.isBanned = banned;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take:    limit,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { orders: true, deposits: true } } },
    }),
    prisma.user.count({ where }),
  ]);

  return { users, total, pages: Math.ceil(total / limit), page };
}

// ─────────────────────────────────────────
// TOTAL COUNT
// ─────────────────────────────────────────
async function getTotalUsers() {
  return prisma.user.count();
}

// ─────────────────────────────────────────
// IS ADMIN
// ─────────────────────────────────────────
function isAdminUser(telegramId) {
  const config = require('../config/settings');
  return config.bot.adminTelegramIds.includes(Number(telegramId));
}

module.exports = {
  findOrCreateUser,
  getUserByTelegramId,
  getUserById,
  getUserByReferralCode,
  updateUser,
  banUser,
  unbanUser,
  listUsers,
  getTotalUsers,
  isAdminUser,
};
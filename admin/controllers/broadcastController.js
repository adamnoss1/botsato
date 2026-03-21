const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { logAudit } = require('../../middleware/auth');

async function index(req, res) {
  const logs = await prisma.broadcastLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  res.render('broadcast', { title: 'الإعلانات', logs });
}

async function send(req, res) {
  const { message, parseMode } = req.body;

  if (!message || message.trim().length < 5) {
    req.session.error = 'الرسالة قصيرة جداً';
    return res.redirect('/admin/broadcast');
  }

  let sentCount   = 0;
  let failedCount = 0;

  try {
    const { bot } = require('../../bot/bot');
    if (!bot) throw new Error('Bot not initialized');

    // Get all active, non-banned users
    const users = await prisma.user.findMany({
      where:  { isBanned: false, isActive: true },
      select: { telegramId: true },
    });

    // Send in batches of 30 (Telegram rate limit)
    const BATCH_SIZE = 30;
    const DELAY_MS   = 1000;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async (u) => {
          try {
            await bot.telegram.sendMessage(
              Number(u.telegramId),
              message,
              { parse_mode: parseMode === 'html' ? 'HTML' : 'Markdown' }
            );
            sentCount++;
          } catch (_) {
            failedCount++;
          }
        })
      );

      // Delay between batches
      if (i + BATCH_SIZE < users.length) {
        await new Promise(r => setTimeout(r, DELAY_MS));
      }
    }

    // Log broadcast
    await prisma.broadcastLog.create({
      data: {
        message,
        sentCount,
        failedCount,
        sentBy: req.session.admin.id,
      },
    });

    await logAudit({
      adminId:  req.session.admin.id,
      action:   'BROADCAST',
      details:  { sentCount, failedCount, messageLength: message.length },
      ipAddress: req.ip,
    });

    req.session.success = `تم إرسال الإعلان إلى ${sentCount} مستخدم (فشل: ${failedCount})`;
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/broadcast');
}

module.exports = { index, send };
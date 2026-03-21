const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function index(req, res) {
  const page   = parseInt(req.query.page) || 1;
  const action = req.query.action || '';
  const skip   = (page - 1) * 30;

  const where = {};
  if (action) where.action = { contains: action, mode: 'insensitive' };

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take:    30,
      orderBy: { createdAt: 'desc' },
      include: { admin: { select: { username: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.render('audit-logs', {
    title: 'سجل العمليات',
    logs, total,
    pages: Math.ceil(total / 30),
    page,
    currentAction: action,
  });
}

module.exports = { index };
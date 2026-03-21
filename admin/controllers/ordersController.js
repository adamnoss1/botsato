const orderSvc     = require('../../services/orderService');
const { logAudit } = require('../../middleware/auth');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function index(req, res) {
  const page   = parseInt(req.query.page) || 1;
  const status = req.query.status || null;
  const search = req.query.search || '';

  const where = {};
  if (status) where.status = status;
  if (search) {
    const numId = parseInt(search);
    if (!isNaN(numId)) where.id = numId;
  }

  const skip = (page - 1) * 20;
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take:    20,
      orderBy: { createdAt: 'desc' },
      include: { user: true, product: true },
    }),
    prisma.order.count({ where }),
  ]);

  res.render('orders', {
    title:  'الطلبات التلقائية',
    orders, total,
    pages:  Math.ceil(total / 20),
    page,
    currentStatus: status || '',
    search,
  });
}

async function manualIndex(req, res) {
  const page   = parseInt(req.query.page) || 1;
  const status = req.query.status || null;

  const where = {};
  if (status) where.status = status;

  const skip = (page - 1) * 20;
  const [orders, total] = await Promise.all([
    prisma.manualOrder.findMany({
      where,
      skip,
      take:    20,
      orderBy: { createdAt: 'desc' },
      include: { user: true, product: true },
    }),
    prisma.manualOrder.count({ where }),
  ]);

  res.render('manual-orders', {
    title: 'الطلبات اليدوية',
    orders, total,
    pages: Math.ceil(total / 20),
    page,
    currentStatus: status || '',
  });
}

async function updateStatus(req, res) {
  const orderId  = parseInt(req.params.id);
  const { status, note } = req.body;

  const validStatuses = ['PENDING','PROCESSING','COMPLETED','PARTIAL','CANCELLED','FAILED'];
  if (!validStatuses.includes(status)) {
    req.session.error = 'حالة غير صالحة';
    return res.redirect('/admin/orders');
  }

  try {
    await prisma.order.update({
      where: { id: orderId },
      data:  { status, adminNote: note || null },
    });

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'UPDATE_ORDER_STATUS',
      targetType: 'order',
      targetId:   orderId,
      details:    { status, note },
      ipAddress:  req.ip,
    });

    req.session.success = `تم تحديث حالة الطلب #${orderId}`;
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/orders');
}

async function updateManualStatus(req, res) {
  const orderId      = parseInt(req.params.id);
  const { status, note } = req.body;

  const validStatuses = ['PENDING','PROCESSING','COMPLETED','CANCELLED','FAILED'];
  if (!validStatuses.includes(status)) {
    req.session.error = 'حالة غير صالحة';
    return res.redirect('/admin/orders/manual');
  }

  try {
    await prisma.manualOrder.update({
      where: { id: orderId },
      data:  { status, adminNote: note || null },
    });

    // If cancelled → refund
    if (status === 'CANCELLED') {
      const order = await prisma.manualOrder.findUnique({ where: { id: orderId } });
      const { creditBalance } = require('../../services/walletService');
      await creditBalance(
        order.userId,
        parseFloat(order.totalPrice),
        'REFUND',
        `استرداد - طلب يدوي #${orderId} ملغى`
      );
    }

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'UPDATE_MANUAL_ORDER_STATUS',
      targetType: 'manual_order',
      targetId:   orderId,
      details:    { status },
      ipAddress:  req.ip,
    });

    req.session.success = `تم تحديث حالة الطلب اليدوي #${orderId}`;
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/orders/manual');
}

module.exports = { index, manualIndex, updateStatus, updateManualStatus };
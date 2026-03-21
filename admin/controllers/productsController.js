const { PrismaClient }    = require('@prisma/client');
const prisma   = new PrismaClient();
const satofill = require('../../satofill/satofillClient');
const { logAudit } = require('../../middleware/auth');

async function index(req, res) {
  const page   = parseInt(req.query.page) || 1;
  const search = req.query.search || '';
  const skip   = (page - 1) * 30;

  const where = {};
  if (search) {
    where.OR = [
      { name:       { contains: search, mode: 'insensitive' } },
      { satofillId: { contains: search } },
    ];
  }

  const [products, total, groups] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take:    30,
      orderBy: { createdAt: 'desc' },
      include: { group: true },
    }),
    prisma.product.count({ where }),
    prisma.productGroup.findMany({ orderBy: { name: 'asc' } }),
  ]);

  res.render('products', {
    title: 'المنتجات',
    products, total,
    pages: Math.ceil(total / 30),
    page, search, groups,
  });
}

async function createForm(req, res) {
  const groups = await prisma.productGroup.findMany({ orderBy: { name: 'asc' } });
  res.render('product-form', { title: 'إضافة منتج', product: null, groups });
}

async function create(req, res) {
  const {
    groupId, satofillId, name, nameAr,
    description, priceUsd, profitMargin,
    minQuantity, maxQuantity, isManual,
  } = req.body;

  try {
    if (!name)    throw new Error('اسم المنتج مطلوب');
    if (!priceUsd) throw new Error('السعر مطلوب');
    if (!groupId)  throw new Error('الفئة مطلوبة');

    const product = await prisma.product.create({
      data: {
        groupId:      parseInt(groupId),
        satofillId:   satofillId || null,
        name,
        nameAr:       nameAr       || null,
        description:  description  || null,
        priceUsd:     parseFloat(priceUsd),
        profitMargin: parseFloat(profitMargin || '0.20'),
        minQuantity:  parseInt(minQuantity    || '100'),
        maxQuantity:  parseInt(maxQuantity    || '100000'),
        isManual:     isManual === 'on',
        isActive:     true,
      },
    });

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'CREATE_PRODUCT',
      targetType: 'product',
      targetId:   product.id,
      ipAddress:  req.ip,
    });

    req.session.success = 'تم إضافة المنتج بنجاح';
    res.redirect('/admin/products');
  } catch (err) {
    req.session.error = err.message;
    res.redirect('/admin/products/create');
  }
}

async function editForm(req, res) {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    req.session.error = 'معرف غير صالح';
    return res.redirect('/admin/products');
  }

  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) {
    req.session.error = 'المنتج غير موجود';
    return res.redirect('/admin/products');
  }

  const groups = await prisma.productGroup.findMany({ orderBy: { name: 'asc' } });
  res.render('product-form', { title: `تعديل: ${product.name}`, product, groups });
}

async function update(req, res) {
  const productId = parseInt(req.params.id);
  if (isNaN(productId)) {
    req.session.error = 'معرف غير صالح';
    return res.redirect('/admin/products');
  }

  const {
    name, nameAr, description, priceUsd,
    profitMargin, minQuantity, maxQuantity,
    isActive, isManual, groupId,
  } = req.body;

  try {
    if (!name)     throw new Error('اسم المنتج مطلوب');
    if (!priceUsd) throw new Error('السعر مطلوب');
    if (!groupId)  throw new Error('الفئة مطلوبة');

    await prisma.product.update({
      where: { id: productId },
      data: {
        name,
        nameAr:       nameAr      || null,
        description:  description || null,
        priceUsd:     parseFloat(priceUsd),
        profitMargin: parseFloat(profitMargin || '0.20'),
        minQuantity:  parseInt(minQuantity),
        maxQuantity:  parseInt(maxQuantity),
        isActive:     isActive === 'on',
        isManual:     isManual === 'on',
        groupId:      parseInt(groupId),
      },
    });

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'UPDATE_PRODUCT',
      targetType: 'product',
      targetId:   productId,
      ipAddress:  req.ip,
    });

    req.session.success = 'تم تحديث المنتج';
    res.redirect('/admin/products');
  } catch (err) {
    req.session.error = err.message;
    res.redirect(`/admin/products/${productId}/edit`);
  }
}

async function deleteProduct(req, res) {
  const productId = parseInt(req.params.id);
  if (isNaN(productId)) {
    req.session.error = 'معرف غير صالح';
    return res.redirect('/admin/products');
  }

  try {
    await prisma.product.delete({ where: { id: productId } });
    await logAudit({
      adminId:    req.session.admin.id,
      action:     'DELETE_PRODUCT',
      targetType: 'product',
      targetId:   productId,
      ipAddress:  req.ip,
    });
    req.session.success = 'تم حذف المنتج';
  } catch (err) {
    req.session.error = err.message;
  }
  res.redirect('/admin/products');
}

// ─────────────────────────────────────────
// SYNC FROM SATOFILL - إصلاح كامل
// ─────────────────────────────────────────
async function syncSatofill(req, res) {
  try {
    const services = await satofill.getServices();

    if (!services || services.length === 0) {
      req.session.error = 'لم يتم استرجاع أي خدمات من Satofill';
      return res.redirect('/admin/products');
    }

    let synced  = 0;
    let skipped = 0;
    let errors  = 0;

    for (const svc of services) {
      try {
        // ── استخراج الحقول بمرونة (API قد يختلف) ──
        const serviceId  = String(svc.service  || svc.id    || '').trim();
        const name       = String(svc.name     || svc.title || `Service ${serviceId}`).trim();
        const category   = String(svc.category || svc.type  || 'General').trim();
        const rateRaw    = svc.rate   || svc.price  || svc.cost || '0';
        const minRaw     = svc.min    || svc.minimum || '100';
        const maxRaw     = svc.max    || svc.maximum || '100000';

        const priceUsd   = parseFloat(rateRaw);
        const minQty     = parseInt(String(minRaw).replace(/[^0-9]/g, '')) || 100;
        const maxQty     = parseInt(String(maxRaw).replace(/[^0-9]/g, '')) || 100000;

        // تجاهل إذا كانت البيانات غير صالحة
        if (!serviceId || isNaN(priceUsd) || priceUsd <= 0) {
          skipped++;
          continue;
        }

        // ── upsert الفئة ──
        let group = await prisma.productGroup.findFirst({
          where: { name: category },
        });
        if (!group) {
          group = await prisma.productGroup.create({
            data: { name: category, isActive: true },
          });
        }

        // ── upsert المنتج ──
        await prisma.product.upsert({
          where:  { satofillId: serviceId },
          update: {
            name,
            priceUsd,
            minQuantity: minQty,
            maxQuantity: maxQty,
            groupId:     group.id,
            isActive:    true,
          },
          create: {
            satofillId:  serviceId,
            name,
            priceUsd,
            minQuantity: minQty,
            maxQuantity: maxQty,
            profitMargin: 0.20,
            isManual:    false,
            isActive:    true,
            groupId:     group.id,
          },
        });

        synced++;
      } catch (svcErr) {
        errors++;
        if (global.logger) {
          global.logger.error(`[SYNC] Service error: ${svcErr.message}`);
        }
      }
    }

    await logAudit({
      adminId:   req.session.admin.id,
      action:    'SYNC_SATOFILL',
      details:   { synced, skipped, errors, total: services.length },
      ipAddress: req.ip,
    });

    req.session.success =
      `تمت المزامنة: ${synced} منتج | تخطي: ${skipped} | أخطاء: ${errors}`;
  } catch (err) {
    req.session.error = `فشل الاتصال بـ Satofill: ${err.message}`;
  }

  res.redirect('/admin/products');
}

module.exports = {
  index,
  createForm,
  create,
  editForm,
  update,
  delete:      deleteProduct,
  syncSatofill,
};
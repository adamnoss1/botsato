// admin/controllers/productsController.js
const { PrismaClient }    = require('@prisma/client');
const prisma   = new PrismaClient();
const satofill = require('../../satofill/satofillClient');
const { logAudit } = require('../../middleware/auth');

async function index(req, res) {
  const page    = parseInt(req.query.page) || 1;
  const search  = req.query.search || '';
  const groupId = req.query.groupId ? parseInt(req.query.groupId) : null;
  const skip    = (page - 1) * 30;

  const where = {};
  if (search) {
    where.OR = [
      { name:       { contains: search, mode: 'insensitive' } },
      { satofillId: { contains: search } },
    ];
  }
  if (groupId) where.groupId = groupId;

  const [products, total, allGroups] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take:    30,
      orderBy: { createdAt: 'desc' },
      include: { group: { include: { parent: true } } },
    }),
    prisma.product.count({ where }),
    prisma.productGroup.findMany({
      orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }],
      include: { parent: true },
    }),
  ]);

  res.render('products', {
    title: 'المنتجات',
    products, total,
    pages: Math.ceil(total / 30),
    page, search,
    groups: allGroups,
    currentGroupId: groupId,
  });
}

async function createForm(req, res) {
  const groups = await prisma.productGroup.findMany({
    orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
    include: { parent: true },
  });
  res.render('product-form', { title: 'إضافة منتج', product: null, groups });
}

async function create(req, res) {
  const {
    groupId, satofillId, name, nameAr,
    description, priceUsd, profitMargin,
    minQuantity, maxQuantity, isManual,
  } = req.body;

  try {
    if (!name)     throw new Error('اسم المنتج مطلوب');
    if (!priceUsd) throw new Error('السعر مطلوب');
    if (!groupId)  throw new Error('التصنيف مطلوب');

    const product = await prisma.product.create({
      data: {
        groupId:      parseInt(groupId),
        satofillId:   satofillId || null,
        name,
        nameAr:       nameAr      || null,
        description:  description || null,
        priceUsd:     parseFloat(priceUsd),
        profitMargin: parseFloat(profitMargin || '0.20'),
        minQuantity:  parseInt(minQuantity    || '1'),
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

  const [product, groups] = await Promise.all([
    prisma.product.findUnique({ where: { id } }),
    prisma.productGroup.findMany({
      orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
      include: { parent: true },
    }),
  ]);

  if (!product) {
    req.session.error = 'المنتج غير موجود';
    return res.redirect('/admin/products');
  }

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
    if (!groupId)  throw new Error('التصنيف مطلوب');

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

async function syncSatofill(req, res) {
  try {
    if (global.logger) global.logger.info('[SYNC] Starting manual sync from admin...');

    const result = await satofill.syncProductsToDB(prisma);

    const groupStats = await prisma.productGroup.groupBy({
      by:    ['parentId'],
      _count: { id: true },
    });

    const rootCount = groupStats.find(g => g.parentId === null)?._count?.id || 0;
    const subCount  = groupStats
      .filter(g => g.parentId !== null)
      .reduce((s, g) => s + g._count.id, 0);

    await logAudit({
      adminId:   req.session.admin.id,
      action:    'SYNC_SATOFILL',
      details:   { synced: result.synced, skipped: result.skipped, errors: result.errors, total: result.total },
      ipAddress: req.ip,
    });

    req.session.success =
      `✅ تمت المزامنة: ${result.synced} منتج | ` +
      `تصنيفات رئيسية: ${rootCount} | ` +
      `تصنيفات فرعية: ${subCount} | ` +
      `أخطاء: ${result.errors}`;

  } catch (err) {
    if (global.logger) global.logger.error('[SYNC] Failed: ' + err.message);
    req.session.error = 'فشل الاتصال بـ Satofill: ' + err.message;
  }

  res.redirect('/admin/products');
}

// ─────────────────────────────────────────
// BULK ASSIGN CATEGORY
// ─────────────────────────────────────────
async function bulkAssignCategory(req, res) {
  const { productIds, groupId } = req.body;

  try {
    if (!groupId) throw new Error('اختر تصنيفاً');

    const rawIds = Array.isArray(productIds) ? productIds : [productIds];
    const ids    = rawIds.map(id => parseInt(id)).filter(id => !isNaN(id));

    if (ids.length === 0) throw new Error('لم تحدد أي منتجات');

    const gId   = parseInt(groupId);
    const group = await prisma.productGroup.findUnique({ where: { id: gId } });
    if (!group) throw new Error('التصنيف غير موجود');

    await prisma.product.updateMany({
      where: { id: { in: ids } },
      data:  { groupId: gId },
    });

    await logAudit({
      adminId:   req.session.admin.id,
      action:    'BULK_ASSIGN_CATEGORY',
      details:   { productIds: ids, groupId: gId, groupName: group.name },
      ipAddress: req.ip,
    });

    req.session.success = `✅ تم نقل ${ids.length} منتج إلى تصنيف "${group.name}"`;

  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/products');
}

// ─────────────────────────────────────────
// CATEGORIES INDEX
// ─────────────────────────────────────────
async function categoriesIndex(req, res) {
  const groups = await prisma.productGroup.findMany({
    orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      parent:   true,
      children: { select: { id: true } },
      _count:   { select: { products: true } },
    },
  });

  const buildTree = (parentId) => {
    return groups
      .filter(g => g.parentId === parentId)
      .map(g => ({ ...g, childGroups: buildTree(g.id) }));
  };
  const tree = buildTree(null);

  res.render('categories', {
    title: 'إدارة التصنيفات',
    groups,
    tree,
  });
}

// ─────────────────────────────────────────
// CREATE CATEGORY
// ─────────────────────────────────────────
async function createCategory(req, res) {
  const { name, parentId } = req.body;

  try {
    if (!name || !name.trim()) throw new Error('اسم التصنيف مطلوب');

    await prisma.productGroup.create({
      data: {
        name:     name.trim(),
        parentId: parentId ? parseInt(parentId) : null,
        isActive: true,
        sortOrder: 0,
      },
    });

    await logAudit({
      adminId:   req.session.admin.id,
      action:    'CREATE_CATEGORY',
      ipAddress: req.ip,
      details:   { name, parentId: parentId || null },
    });

    req.session.success = 'تم إضافة التصنيف: ' + name.trim();
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/categories');
}

// ─────────────────────────────────────────
// UPDATE CATEGORY PARENT
// ─────────────────────────────────────────
async function updateCategoryParent(req, res) {
  const id       = parseInt(req.params.id);
  const parentId = req.body.parentId ? parseInt(req.body.parentId) : null;

  try {
    if (id === parentId) throw new Error('لا يمكن تعيين التصنيف كأب لنفسه');

    if (parentId) {
      const potentialParent = await prisma.productGroup.findUnique({ where: { id: parentId } });
      if (potentialParent && potentialParent.parentId === id) {
        throw new Error('لا يمكن إنشاء حلقة في التصنيفات');
      }
    }

    await prisma.productGroup.update({
      where: { id },
      data:  { parentId },
    });

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'UPDATE_CATEGORY_PARENT',
      targetType: 'product_group',
      targetId:   id,
      details:    { parentId },
      ipAddress:  req.ip,
    });

    req.session.success = 'تم تحديث التصنيف الأب';
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/categories');
}

// ─────────────────────────────────────────
// DELETE CATEGORY
// ─────────────────────────────────────────
async function deleteCategory(req, res) {
  const id = parseInt(req.params.id);

  try {
    const [productCount, childCount] = await Promise.all([
      prisma.product.count({ where: { groupId: id } }),
      prisma.productGroup.count({ where: { parentId: id } }),
    ]);

    if (productCount > 0) throw new Error('لا يمكن حذف تصنيف يحتوي على منتجات (' + productCount + ')');
    if (childCount > 0)   throw new Error('لا يمكن حذف تصنيف يحتوي على تصنيفات فرعية (' + childCount + ')');

    await prisma.productGroup.delete({ where: { id } });

    await logAudit({
      adminId:    req.session.admin.id,
      action:     'DELETE_CATEGORY',
      targetType: 'product_group',
      targetId:   id,
      ipAddress:  req.ip,
    });

    req.session.success = 'تم حذف التصنيف';
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/categories');
}

// ─────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────
module.exports = {
  index,
  createForm,
  create,
  editForm,
  update,
  delete:               deleteProduct,
  syncSatofill,
  bulkAssignCategory,
  categoriesIndex,
  createCategory,
  updateCategoryParent,
  deleteCategory,
};
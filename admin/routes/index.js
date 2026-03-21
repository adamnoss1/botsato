const express    = require('express');
const router     = express.Router();
const {
  authMiddleware,
  handleLogin,
  handleLogout,
  superAdminOnly,
} = require('../../middleware/auth');
const { strictRateLimit } = require('../../middleware/rateLimit');

const dashboardCtrl   = require('../controllers/dashboardController');
const usersCtrl       = require('../controllers/usersController');
const depositsCtrl    = require('../controllers/depositsController');
const withdrawalsCtrl = require('../controllers/withdrawalsController');
const ordersCtrl      = require('../controllers/ordersController');
const productsCtrl    = require('../controllers/productsController');
const methodsCtrl     = require('../controllers/methodsController');
const broadcastCtrl   = require('../controllers/broadcastController');
const settingsCtrl    = require('../controllers/settingsController');
const adminsCtrl      = require('../controllers/adminsController');
const auditCtrl       = require('../controllers/auditController');
const backupCtrl      = require('../controllers/backupController');

// ─────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.admin) return res.redirect('/admin/dashboard');
  // csrfToken متاح عبر res.locals من middleware في app.js
  res.render('login', {
    error:     res.locals.error || null,
    csrfToken: res.locals.csrfToken || '',
  });
});

router.post('/login',  strictRateLimit, handleLogin);
router.post('/logout', authMiddleware,  handleLogout);

// ─────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────
router.get('/dashboard', authMiddleware, dashboardCtrl.index);

// ─────────────────────────────────────────
// USERS
// ─────────────────────────────────────────
router.get('/users',               authMiddleware, usersCtrl.index);
router.get('/users/:id',           authMiddleware, usersCtrl.show);
router.get('/users/:id/edit',      authMiddleware, usersCtrl.editForm);
router.post('/users/:id/balance',  authMiddleware, usersCtrl.adjustBalance);
router.post('/users/:id/ban',      authMiddleware, usersCtrl.ban);
router.post('/users/:id/unban',    authMiddleware, usersCtrl.unban);
router.post('/users/:id/referral', authMiddleware, superAdminOnly, usersCtrl.changeReferral);

// ─────────────────────────────────────────
// DEPOSITS
// ─────────────────────────────────────────
router.get('/deposits',               authMiddleware, depositsCtrl.index);
router.post('/deposits/:id/approve',  authMiddleware, depositsCtrl.approve);
router.post('/deposits/:id/reject',   authMiddleware, depositsCtrl.reject);

// ─────────────────────────────────────────
// WITHDRAWALS
// ─────────────────────────────────────────
router.get('/withdrawals',                authMiddleware, withdrawalsCtrl.index);
router.post('/withdrawals/:id/approve',   authMiddleware, withdrawalsCtrl.approve);
router.post('/withdrawals/:id/complete',  authMiddleware, withdrawalsCtrl.complete);
router.post('/withdrawals/:id/reject',    authMiddleware, withdrawalsCtrl.reject);

// ─────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────
router.get('/orders',                      authMiddleware, ordersCtrl.index);
router.get('/orders/manual',               authMiddleware, ordersCtrl.manualIndex);
router.post('/orders/:id/status',          authMiddleware, ordersCtrl.updateStatus);
router.post('/orders/manual/:id/status',   authMiddleware, ordersCtrl.updateManualStatus);

// ─────────────────────────────────────────
// PRODUCTS
// ─────────────────────────────────────────
router.get('/products',              authMiddleware, productsCtrl.index);
router.get('/products/create',       authMiddleware, productsCtrl.createForm);
router.post('/products',             authMiddleware, productsCtrl.create);
router.get('/products/:id/edit',     authMiddleware, productsCtrl.editForm);
router.post('/products/:id',         authMiddleware, productsCtrl.update);
router.post('/products/:id/delete',  authMiddleware, superAdminOnly, productsCtrl.delete);
router.post('/products/sync',        authMiddleware, productsCtrl.syncSatofill);

// ─────────────────────────────────────────
// DEPOSIT METHODS
// ─────────────────────────────────────────
router.get('/deposit-methods',              authMiddleware, methodsCtrl.depositIndex);
router.get('/deposit-methods/create',       authMiddleware, methodsCtrl.depositCreateForm);
router.post('/deposit-methods',             authMiddleware, methodsCtrl.depositCreate);
router.get('/deposit-methods/:id/edit',     authMiddleware, methodsCtrl.depositEditForm);
router.post('/deposit-methods/:id',         authMiddleware, methodsCtrl.depositUpdate);
router.post('/deposit-methods/:id/toggle',  authMiddleware, methodsCtrl.depositToggle);

// ─────────────────────────────────────────
// WITHDRAW METHODS
// ─────────────────────────────────────────
router.get('/withdraw-methods',              authMiddleware, methodsCtrl.withdrawIndex);
router.get('/withdraw-methods/create',       authMiddleware, methodsCtrl.withdrawCreateForm);
router.post('/withdraw-methods',             authMiddleware, methodsCtrl.withdrawCreate);
router.get('/withdraw-methods/:id/edit',     authMiddleware, methodsCtrl.withdrawEditForm);
router.post('/withdraw-methods/:id',         authMiddleware, methodsCtrl.withdrawUpdate);
router.post('/withdraw-methods/:id/toggle',  authMiddleware, methodsCtrl.withdrawToggle);

// ─────────────────────────────────────────
// BROADCAST
// ─────────────────────────────────────────
router.get('/broadcast',  authMiddleware, broadcastCtrl.index);
router.post('/broadcast', authMiddleware, broadcastCtrl.send);

// ─────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────
router.get('/settings',  authMiddleware, settingsCtrl.index);
router.post('/settings', authMiddleware, settingsCtrl.update);

// ─────────────────────────────────────────
// ADMINS
// ─────────────────────────────────────────
router.get('/admins',               authMiddleware, superAdminOnly, adminsCtrl.index);
router.post('/admins',              authMiddleware, superAdminOnly, adminsCtrl.create);
router.post('/admins/:id/toggle',   authMiddleware, superAdminOnly, adminsCtrl.toggle);
router.post('/admins/:id/delete',   authMiddleware, superAdminOnly, adminsCtrl.delete);
router.post('/admins/:id/password', authMiddleware, superAdminOnly, adminsCtrl.changePassword);

// ─────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────
router.get('/audit-logs', authMiddleware, auditCtrl.index);

// ─────────────────────────────────────────
// BACKUP
// ─────────────────────────────────────────
router.get('/backup',                    authMiddleware, superAdminOnly, backupCtrl.index);
router.post('/backup/create',            authMiddleware, superAdminOnly, backupCtrl.create);
router.get('/backup/download/:filename', authMiddleware, superAdminOnly, backupCtrl.download);
router.post('/backup/delete/:filename',  authMiddleware, superAdminOnly, backupCtrl.delete);

module.exports = router;
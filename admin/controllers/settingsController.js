const { getAllSettings, setSettings } = require('../../services/settingsService');
const { logAudit } = require('../../middleware/auth');

async function index(req, res) {
  const settings = await getAllSettings();
  res.render('settings', { title: 'الإعدادات', settings });
}

async function update(req, res) {
  try {
    const allowed = [
      'exchange_rate', 'profit_margin',
      'maintenance_mode', 'channel_verification',
      'referral_commission',
      'min_deposit', 'max_deposit',
      'min_withdraw', 'max_withdraw',
      'vip_bronze_threshold', 'vip_silver_threshold', 'vip_gold_threshold',
      'vip_bronze_discount', 'vip_silver_discount', 'vip_gold_discount',
      'support_min_length', 'bot_name', 'welcome_message',
    ];

    const data = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // Booleans
        if (key === 'maintenance_mode' || key === 'channel_verification') {
          data[key] = req.body[key] === 'on' ? 'true' : 'false';
        } else {
          data[key] = req.body[key];
        }
      }
    }

    // Handle checkboxes that weren't sent (means unchecked)
    if (req.body.maintenance_mode === undefined)     data.maintenance_mode     = 'false';
    if (req.body.channel_verification === undefined) data.channel_verification = 'false';

    await setSettings(data);

    await logAudit({
      adminId:  req.session.admin.id,
      action:   'UPDATE_SETTINGS',
      details:  data,
      ipAddress: req.ip,
    });

    req.session.success = 'تم حفظ الإعدادات بنجاح';
  } catch (err) {
    req.session.error = err.message;
  }

  res.redirect('/admin/settings');
}

module.exports = { index, update };
const path = require('path');
const fs   = require('fs');
const backupJob = require('../../jobs/backupJob');
const { logAudit } = require('../../middleware/auth');

async function index(req, res) {
  const backups = backupJob.listBackups();
  res.render('backup', { title: 'النسخ الاحتياطية', backups });
}

async function create(req, res) {
  try {
    const result = await backupJob.createBackup();
    await logAudit({
      adminId:  req.session.admin.id,
      action:   'CREATE_BACKUP',
      details:  { filename: result.filename, size: result.size },
      ipAddress: req.ip,
    });
    req.session.success = `تم إنشاء نسخة احتياطية: ${result.filename}`;
  } catch (err) {
    req.session.error = err.message;
  }
  res.redirect('/admin/backup');
}

async function download(req, res) {
  try {
    const filename = req.params.filename;
    // Sanitize filename
    if (!/^backup_[\w\-]+\.(sql|json)$/.test(filename)) {
      return res.status(400).send('Invalid filename');
    }

    const filepath = backupJob.getBackupPath(filename);
    res.download(filepath, filename);

    await logAudit({
      adminId:  req.session.admin.id,
      action:   'DOWNLOAD_BACKUP',
      details:  { filename },
      ipAddress: req.ip,
    });
  } catch (err) {
    req.session.error = err.message;
    res.redirect('/admin/backup');
  }
}

async function deleteBackup(req, res) {
  try {
    const filename = req.params.filename;
    if (!/^backup_[\w\-]+\.(sql|json)$/.test(filename)) {
      throw new Error('Invalid filename');
    }

    const filepath = backupJob.getBackupPath(filename);
    fs.unlinkSync(filepath);

    await logAudit({
      adminId:  req.session.admin.id,
      action:   'DELETE_BACKUP',
      details:  { filename },
      ipAddress: req.ip,
    });

    req.session.success = 'تم حذف النسخة الاحتياطية';
  } catch (err) {
    req.session.error = err.message;
  }
  res.redirect('/admin/backup');
}

module.exports = { index, create, download, delete: deleteBackup };
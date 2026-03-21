// jobs/backupJob.js
const cron   = require('node-cron');
const fs     = require('fs');
const path   = require('path');
const { exec } = require('child_process');
const config   = require('../config/settings');

// ─────────────────────────────────────────
// BIGINT REPLACER — لحل مشكلة JSON.stringify
// ─────────────────────────────────────────
function bigIntReplacer(key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

// ─────────────────────────────────────────
// ENSURE BACKUP DIR EXISTS
// ─────────────────────────────────────────
function ensureBackupDir() {
  const dir = path.resolve(config.backup.dir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ─────────────────────────────────────────
// CREATE DATABASE BACKUP
// ─────────────────────────────────────────
async function createBackup() {
  return new Promise((resolve, reject) => {
    const dir       = ensureBackupDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename  = 'backup_' + timestamp + '.sql';
    const filepath  = path.join(dir, filename);
    const dbUrl     = config.database.url;
    const command   = 'pg_dump "' + dbUrl + '" > "' + filepath + '"';

    exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        if (global.logger) {
          global.logger.error('[JOB:backup] pg_dump failed: ' + error.message);
        }
        // Fallback: JSON export
        createJsonBackup(dir, timestamp)
          .then(resolve)
          .catch(reject);
        return;
      }

      const stats = fs.statSync(filepath);
      if (global.logger) {
        global.logger.info(
          '[JOB:backup] SQL backup created: ' + filename +
          ' (' + (stats.size / 1024).toFixed(2) + ' KB)'
        );
      }

      cleanOldBackups(dir, 7);
      resolve({ filename, filepath, size: stats.size });
    });
  });
}

// ─────────────────────────────────────────
// FALLBACK: JSON BACKUP
// ─────────────────────────────────────────
async function createJsonBackup(dir, timestamp) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const [
      users,
      orders,
      deposits,
      withdrawals,
      settings,
      referrals,
      manualOrders,
      products,
      productGroups,
    ] = await Promise.all([
      prisma.user.findMany(),
      prisma.order.findMany(),
      prisma.deposit.findMany(),
      prisma.withdrawal.findMany(),
      prisma.setting.findMany(),
      prisma.referral.findMany(),
      prisma.manualOrder.findMany(),
      prisma.product.findMany(),
      prisma.productGroup.findMany(),
    ]);

    const backup = {
      createdAt:    new Date().toISOString(),
      version:      '1.0',
      users,
      orders,
      deposits,
      withdrawals,
      settings,
      referrals,
      manualOrders,
      products,
      productGroups,
    };

    const ts       = timestamp || new Date().toISOString().replace(/[:.]/g, '-');
    const filename = 'backup_' + ts + '.json';
    const filepath = path.join(dir, filename);

    // ── الإصلاح: bigIntReplacer يحل مشكلة telegramId ──
    fs.writeFileSync(filepath, JSON.stringify(backup, bigIntReplacer, 2));

    const stats = fs.statSync(filepath);

    if (global.logger) {
      global.logger.info(
        '[JOB:backup] JSON backup created: ' + filename +
        ' (' + (stats.size / 1024).toFixed(2) + ' KB)'
      );
    }

    cleanOldBackups(dir, 7);

    return { filename, filepath, size: stats.size };

  } catch (err) {
    if (global.logger) global.logger.error('[JOB:backup] createJsonBackup failed: ' + err.message);
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

// ─────────────────────────────────────────
// CLEAN OLD BACKUPS — يحتفظ بآخر N نسخة
// ─────────────────────────────────────────
function cleanOldBackups(dir, keepCount) {
  keepCount = keepCount || 7;
  try {
    const files = fs.readdirSync(dir)
      .filter(function(f) {
        return f.startsWith('backup_') && (f.endsWith('.sql') || f.endsWith('.json'));
      })
      .map(function(f) {
        return {
          name: f,
          time: fs.statSync(path.join(dir, f)).mtime.getTime(),
        };
      })
      .sort(function(a, b) { return b.time - a.time; });

    const toDelete = files.slice(keepCount);
    toDelete.forEach(function(file) {
      fs.unlinkSync(path.join(dir, file.name));
      if (global.logger) {
        global.logger.info('[JOB:backup] Deleted old backup: ' + file.name);
      }
    });
  } catch (err) {
    if (global.logger) global.logger.error('[JOB:backup] Clean failed: ' + err.message);
  }
}

// ─────────────────────────────────────────
// LIST BACKUPS
// ─────────────────────────────────────────
function listBackups() {
  const dir = ensureBackupDir();
  try {
    return fs.readdirSync(dir)
      .filter(function(f) {
        return f.startsWith('backup_') && (f.endsWith('.sql') || f.endsWith('.json'));
      })
      .map(function(f) {
        const stats = fs.statSync(path.join(dir, f));
        return {
          filename:  f,
          filepath:  path.join(dir, f),
          size:      stats.size,
          sizeKb:    (stats.size / 1024).toFixed(2),
          createdAt: stats.mtime,
        };
      })
      .sort(function(a, b) { return b.createdAt - a.createdAt; });
  } catch (_) {
    return [];
  }
}

// ─────────────────────────────────────────
// GET BACKUP FILE PATH — مع حماية path traversal
// ─────────────────────────────────────────
function getBackupPath(filename) {
  const dir      = ensureBackupDir();
  const filepath = path.join(dir, filename);
  const resolved = path.resolve(filepath);
  const base     = path.resolve(dir);

  if (!resolved.startsWith(base)) {
    throw new Error('Invalid backup filename');
  }

  if (!fs.existsSync(filepath)) {
    throw new Error('Backup file not found');
  }

  return filepath;
}

// ─────────────────────────────────────────
// SCHEDULED BACKUP — كل يوم الساعة 3:00 صباحاً
// ─────────────────────────────────────────
cron.schedule('0 3 * * *', async function() {
  try {
    if (global.logger) global.logger.info('[JOB:backup] Starting scheduled backup...');
    await createBackup();
  } catch (err) {
    if (global.logger) global.logger.error('[JOB:backup] Scheduled backup failed: ' + err.message);
  }
});

if (global.logger) global.logger.info('Job registered: backupJob (daily at 03:00)');

module.exports = {
  createBackup,
  createJsonBackup,
  listBackups,
  getBackupPath,
  cleanOldBackups,
};
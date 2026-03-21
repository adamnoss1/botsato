const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─────────────────────────────────────────
// GET SINGLE SETTING
// ─────────────────────────────────────────
async function getSetting(key) {
  const setting = await prisma.setting.findUnique({ where: { key } });
  return setting ? setting.value : null;
}

// ─────────────────────────────────────────
// GET ALL SETTINGS AS OBJECT
// ─────────────────────────────────────────
async function getAllSettings() {
  const settings = await prisma.setting.findMany();
  const result   = {};
  for (const s of settings) result[s.key] = s.value;
  return result;
}

// ─────────────────────────────────────────
// SET SETTING
// ─────────────────────────────────────────
async function setSetting(key, value) {
  return prisma.setting.upsert({
    where:  { key },
    update: { value: String(value) },
    create: { key, value: String(value) },
  });
}

// ─────────────────────────────────────────
// SET MULTIPLE SETTINGS
// ─────────────────────────────────────────
async function setSettings(data) {
  const promises = Object.entries(data).map(([key, value]) =>
    setSetting(key, value)
  );
  return Promise.all(promises);
}

// ─────────────────────────────────────────
// CHECK MAINTENANCE MODE
// ─────────────────────────────────────────
async function isMaintenanceMode() {
  const val = await getSetting('maintenance_mode');
  return val === 'true';
}

// ─────────────────────────────────────────
// CHECK CHANNEL VERIFICATION
// ─────────────────────────────────────────
async function isChannelVerificationEnabled() {
  const val = await getSetting('channel_verification');
  return val === 'true';
}

module.exports = {
  getSetting,
  getAllSettings,
  setSetting,
  setSettings,
  isMaintenanceMode,
  isChannelVerificationEnabled,
};
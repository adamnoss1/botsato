const rateLimit = require('express-rate-limit');
const config    = require('../config/settings');

// ─────────────────────────────────────────
// BOT API RATE LIMITER (General)
// ─────────────────────────────────────────
const botRateLimit = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please try again later.',
  },
  skip: (req) => {
    // Skip health checks
    return req.path === '/health';
  },
  keyGenerator: (req) => {
    return req.ip || req.connection.remoteAddress;
  },
});

// ─────────────────────────────────────────
// STRICT RATE LIMITER (Login, Deposit)
// ─────────────────────────────────────────
const strictRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes.' },
});

// ─────────────────────────────────────────
// TELEGRAM USER RATE LIMITER (In-memory)
// ─────────────────────────────────────────
const userRequestMap = new Map();

function telegramRateLimit(ctx, next) {
  const userId = ctx.from?.id;
  if (!userId) return next();

  const now = Date.now();
  const windowMs = config.rateLimit.windowMs;
  const maxRequests = config.rateLimit.maxRequests;

  if (!userRequestMap.has(userId)) {
    userRequestMap.set(userId, { count: 1, resetAt: now + windowMs });
    return next();
  }

  const data = userRequestMap.get(userId);

  if (now > data.resetAt) {
    userRequestMap.set(userId, { count: 1, resetAt: now + windowMs });
    return next();
  }

  if (data.count >= maxRequests) {
    const secondsLeft = Math.ceil((data.resetAt - now) / 1000);
    return ctx.reply(`⚠️ تجاوزت الحد المسموح. انتظر ${secondsLeft} ثانية.`).catch(() => {});
  }

  data.count++;
  return next();
}

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of userRequestMap.entries()) {
    if (now > data.resetAt) userRequestMap.delete(key);
  }
}, 5 * 60 * 1000);

module.exports = { botRateLimit, strictRateLimit, telegramRateLimit };
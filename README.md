# 🚀 Telegram SaaS Platform

منصة خدمات Telegram متكاملة مع Satofill API مع لوحة تحكم ويب احترافية.

---

## ✨ المميزات

- 🤖 بوت Telegram كامل مع جميع الأنظمة
- 🌐 لوحة تحكم ويب (Admin Panel)
- 🔗 تكامل كامل مع Satofill API
- 💰 نظام محفظة (إيداع / سحب / تحويل)
- 📦 خدمات تلقائية ويدوية
- 🏆 نظام VIP متعدد المستويات
- 👥 نظام إحالة مع عمولات
- 🔔 إشعارات Telegram للمديرين
- 🔄 مزامنة تلقائية في الخلفية
- 🛡️ حماية أمنية متكاملة
- 💾 نسخ احتياطية تلقائية

---

## 📋 المتطلبات

- Node.js >= 18.0.0
- PostgreSQL >= 13
- حساب Telegram Bot (BotFather)
- مفتاح Satofill API

---

## ⚡ التشغيل السريع

### 1. استنساخ المشروع
```bash
git clone https://github.com/your-repo/telegram-saas-platform.git
cd telegram-saas-platform
```

### 2. تثبيت المتطلبات
```bash
npm install
```

### 3. إعداد متغيرات البيئة
```bash
cp .env.example .env
```

ثم عدّل ملف `.env` وأضف القيم الصحيحة:
```env
BOT_TOKEN=your_bot_token
DATABASE_URL=postgresql://user:pass@host:5432/dbname
ADMIN_PASSWORD=your_secure_password
SATOFILL_API_KEY=your_api_key
SESSION_SECRET=random_32_char_string
EXCHANGE_RATE=3.75
```

### 4. تهيئة قاعدة البيانات
```bash
npx prisma migrate deploy
npx prisma generate
```

### 5. تشغيل المشروع
```bash
npm start
```

### 6. الوصول للوحة التحكم
```
http://localhost:3000/admin
```

بيانات الدخول الافتراضية:
- المستخدم: `admin` (أو ما حددته في ADMIN_USERNAME)
- كلمة المرور: ما حددته في ADMIN_PASSWORD

---

## 🚂 النشر على Railway

### الطريقة الأولى: عبر GitHub

1. ارفع المشروع على GitHub
2. اذهب إلى [railway.app](https://railway.app)
3. اضغط **New Project** → **Deploy from GitHub repo**
4. اختر المستودع
5. أضف قاعدة بيانات PostgreSQL:
   - اضغط **New** → **Database** → **PostgreSQL**
6. أضف متغيرات البيئة في تبويب **Variables**:
```
BOT_TOKEN=
DATABASE_URL=           ← يُضاف تلقائياً من PostgreSQL
ADMIN_PASSWORD=
ADMIN_USERNAME=admin
SATOFILL_API_KEY=
SESSION_SECRET=
EXCHANGE_RATE=3.75
PROFIT_MARGIN=0.20
ADMIN_TELEGRAM_IDS=
SUPPORT_CHANNEL_ID=
NOTIFICATION_CHANNEL_ID=
REQUIRED_CHANNEL_ID=
REQUIRED_CHANNEL_USERNAME=
NODE_ENV=production
APP_URL=https://your-app.railway.app
```

7. Railway سيبني المشروع تلقائياً وينفذ:
```bash
npm install && npx prisma generate && npx prisma migrate deploy
npm start
```

### الطريقة الثانية: Railway CLI
```bash
npm install -g @railway/cli
railway login
railway init
railway add postgresql
railway up
```

---

## 🏗️ هيكل المشروع
```
/project
├── src/
│   ├── app.js          ← Express app
│   └── server.js       ← Entry point
├── bot/
│   ├── bot.js          ← Telegraf setup
│   ├── handlers.js     ← All bot handlers
│   └── keyboards.js    ← Keyboard layouts
├── satofill/
│   └── satofillClient.js ← API client
├── services/
│   ├── userService.js
│   ├── walletService.js
│   ├── orderService.js
│   ├── depositService.js
│   ├── withdrawService.js
│   ├── referralService.js
│   ├── vipService.js
│   ├── settingsService.js
│   └── notificationService.js
├── admin/
│   ├── routes/index.js
│   ├── controllers/    ← 12 controllers
│   └── views/          ← 17 EJS templates
├── middleware/
│   ├── auth.js
│   └── rateLimit.js
├── jobs/
│   ├── orderSync.js    ← Every 1 min
│   ├── cacheRefresh.js ← Every 30 sec
│   ├── dailyStats.js   ← Daily midnight
│   └── backupJob.js    ← Daily 03:00
├── prisma/
│   └── schema.prisma
├── config/
│   └── settings.js
├── public/css/
│   └── admin.css
├── .env.example
├── package.json
├── railway.json
└── README.md
```

---

## 🔒 الأمان

| الميزة | التفاصيل |
|--------|---------|
| تشفير كلمات المرور | bcrypt (cost=12) |
| قفل الحساب | بعد 5 محاولات فاشلة لمدة 30 دقيقة |
| CSRF Protection | على جميع طلبات POST |
| Security Headers | Helmet.js |
| Rate Limiting | 30 طلب/دقيقة للبوت، 10/15دق للتسجيل |
| Session Store | PostgreSQL (مشفر) |
| SQL Injection | محمي عبر Prisma ORM |
| Path Traversal | حماية في Backup |

---

## 📊 Background Jobs

| الوظيفة | التوقيت | الغرض |
|---------|---------|-------|
| orderSync | كل دقيقة | مزامنة حالة الطلبات مع Satofill |
| cacheRefresh | كل 30 ثانية | تحديث المنتجات من Satofill |
| dailyStats | منتصف الليل | إحصائيات يومية |
| backupJob | 3:00 صباحاً | نسخ احتياطية تلقائية |

---

## 🤖 أوامر البوت

| الزر | الوظيفة |
|------|---------|
| 📊 معاملاتي | سجل الإيداعات والسحوبات والطلبات |
| 💰 محفظتي | إيداع، سحب، تحويل، رصيد |
| ⚡️ شحن تلقائي | طلب خدمة من Satofill |
| ⚙️ شحن يدوي | طلب خدمة يدوية |
| 🎧 الدعم الفني | إرسال رسالة للدعم |
| 📢 الإعلانات | آخر إعلان |
| 🔧 أنظمة البوت | معلومات النظام |
| 👥 الإحالة | رابط الإحالة والإحصائيات |

---

## 🛠️ حل المشكلات الشائعة

### مشكلة: البوت لا يستجيب
```bash
# تحقق من صحة BOT_TOKEN
curl https://api.telegram.org/bot<TOKEN>/getMe
```

### مشكلة: خطأ في قاعدة البيانات
```bash
# إعادة تشغيل migrations
npx prisma migrate reset
npx prisma migrate deploy
```

### مشكلة: Prisma Client غير محدّث
```bash
npx prisma generate
```

### مشكلة: Session لا تعمل
- تأكد أن `SESSION_SECRET` أطول من 32 حرف
- تأكد أن `DATABASE_URL` صحيح

---

## 📞 المتغيرات البيئية الكاملة

| المتغير | مطلوب | الوصف |
|---------|-------|-------|
| `BOT_TOKEN` | ✅ | رمز بوت Telegram |
| `DATABASE_URL` | ✅ | رابط PostgreSQL |
| `SESSION_SECRET` | ✅ | مفتاح تشفير الجلسات |
| `ADMIN_PASSWORD` | ✅ | كلمة مرور لوحة التحكم |
| `SATOFILL_API_KEY` | ✅ | مفتاح Satofill API |
| `ADMIN_TELEGRAM_IDS` | ✅ | IDs المديرين (فاصلة) |
| `SUPPORT_CHANNEL_ID` | ⚠️ | قناة رسائل الدعم |
| `NOTIFICATION_CHANNEL_ID` | ⚠️ | قناة الإشعارات |
| `REQUIRED_CHANNEL_ID` | ⚠️ | قناة التحقق من الاشتراك |
| `EXCHANGE_RATE` | ✅ | سعر الصرف الافتراضي |
| `PROFIT_MARGIN` | ✅ | هامش الربح الافتراضي |
| `NODE_ENV` | ✅ | `production` أو `development` |
| `APP_URL` | ✅ | رابط التطبيق |
| `BOT_USERNAME` | ⚠️ | اسم البوت بدون @ |
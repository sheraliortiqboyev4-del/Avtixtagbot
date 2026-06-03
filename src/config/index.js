require('dotenv').config(); 

module.exports = { 
    botToken: process.env.BOT_TOKEN, 
    apiId: parseInt(process.env.API_ID) || 36529764, 
    apiHash: process.env.API_HASH || "da5eccc1fa8d9913db7d984a145b9972", 
    adminId: parseInt(process.env.ADMIN_ID), 
    databaseUrl: process.env.DATABASE_URL, 
    port: process.env.PORT || 3000,
    botPromoUsername: process.env.BOT_PROMO_USERNAME || '@Foydasizku_bot',
    
    // Auth ulanish (Render/cloud: WSS=443 odatda yaxshi ishlaydi)
    authUseWss: process.env.AUTH_USE_WSS !== '0',
    authReceiveUpdates: false,
    telegramProxy: process.env.TELEGRAM_PROXY_HOST
        ? {
            host: process.env.TELEGRAM_PROXY_HOST,
            port: parseInt(process.env.TELEGRAM_PROXY_PORT || '443', 10),
            secret: process.env.TELEGRAM_PROXY_SECRET || ''
        }
        : null,
    tgDeviceModel: process.env.TG_DEVICE_MODEL || 'AvtoBotPro_v2',
    tgSystemVersion: process.env.TG_SYSTEM_VERSION || 'Windows 10',
    tgAppVersion: process.env.TG_APP_VERSION || 'Telegram Desktop 1.0.0',
};

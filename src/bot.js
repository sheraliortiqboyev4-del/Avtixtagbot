// --- 0. GLOBAL ERROR HANDLING (CRASH PROTECTION) ---
process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION:', err.message);
    console.error(err.stack);
    // Jarayonni to'xtatmaymiz, shunchaki log qilamiz
});

process.on('unhandledRejection', (reason, promise) => {
    // Kutilgan xatolarni unhandled deb ko'rsatmaslik uchun
    const isExpectedError = 
        reason && 
        reason.response && 
        reason.response.statusCode && 
        [400, 403, 404, 429].includes(reason.response.statusCode);
    if (isExpectedError) {
        console.log(`⚠️ [Expected Unhandled Error] Ignoring: ${reason.message}`);
        return;
    }
    console.error('❌ UNHANDLED REJECTION at:', promise, 'reason:', reason);
});



const TelegramBot = require('node-telegram-bot-api'); 
const { connectDB, reconnectDB, ensureSchema, setDbReady, getDbReady, sequelize } = require('./config/db'); 
const express = require('express');
const dns = require('dns');
const os = require('os');
const config = require('./config'); 
const User = require('./models/User'); 
const { blockExpiredUser, loadAllStates } = require('./services/userbot');
const { runExpirySweep } = require('./services/expiry'); 
const { withPremiumEmojis } = require('./utils/helpers');
const { restoreDB, backupDB, triggerBackup, verifyDatabaseAfterConnect, startBackupScheduler } = require('./utils/dbBackup');

// --- 1. SERVER & DNS SETUP ---
try {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
    console.log("DNS serverlarini o'zgartirib bo'lmadi.");
}

const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));

// --- RENDER SELF-PING SYSTEM ---
const axios = require('axios');
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || (process.env.RENDER_SERVICE_NAME ? `https://${process.env.RENDER_SERVICE_NAME}.onrender.com` : null);

if (RENDER_URL) {
    console.log(`📡 Self-ping tizimi faollashtirildi: ${RENDER_URL}`);
    setInterval(() => {
        axios.get(RENDER_URL)
            .then(() => console.log('📡 Self-ping: Bot uyg\'oq!'))
            .catch((err) => {
                // Xatolikni faqat bir qator qilib log qilamiz, loglarni to'ldirmaslik uchun
                console.log('📡 Self-ping ulanish xatosi (Bot baribir ishlayapti)');
            });
    }, 10 * 60 * 1000); // Har 10 daqiqada
} else {
    console.log('📡 Self-ping tizimi ishga tushmadi (URL topilmadi)');
}

const startServer = (port) => {
    const p = parseInt(port);
    app.listen(p, () => {
        console.log(`✅ Server running on port ${p}`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`⚠️ Port ${p} band, ${p + 1} urinib ko'rilmoqda...`);
            startServer(p + 1);
        } else {
            console.error("Server error:", err);
        }
    });
};

startServer(config.port || 3000);

// --- 2. BOT INITIALIZATION ---
const bot = new TelegramBot(config.botToken, { 
    polling: {
        interval: 300,
        autoStart: false,
        params: {
            timeout: 10
        }
    }
});

// --- WRAPPER FOR TELEGRAM BOT METHODS (ANTI-FLOOD, PREMIUM EMOJIS & ERROR PROTECTION) ---
const baseSendMessage = bot.sendMessage.bind(bot);
bot.sendMessage = async (chatId, text, options = {}, retryCount = 0) => {
    const { skipEmojiWrap, ...sendOptions } = options;

    try {
        let finalOptions = { ...sendOptions };
        let finalText = text;

        if (!skipEmojiWrap) {
            const { cleanText, entities } = withPremiumEmojis(text);
            if (entities && entities.length > 0) {
                finalOptions.entities = entities;
                delete finalOptions.parse_mode;
                finalText = cleanText;
            }
        }

        return await baseSendMessage(chatId, finalText, finalOptions);
    } catch (error) {
        // Kutilgan xatolar: 403 (bloklangan), 400 (chat topilmadi), 404 (chat topilmadi)
        const isExpectedError = 
            error.response && 
            error.response.statusCode && 
            [400, 403, 404].includes(error.response.statusCode);
        
        if (isExpectedError) {
            console.log(`⚠️ [Expected Error] Xabar yuborib bo'lmadi (${chatId}): ${error.message}`);
            return null;
        }

        // 429 Too Many Requests (Flood)
        if (error.code === 'ETELEGRAM' && error.response && error.response.body && error.response.body.parameters) {
            const retryAfter = error.response.body.parameters.retry_after;
            if (retryAfter && retryCount < 3) {
                console.log(`⚠️ [429 Flood] bot.sendMessage uchun ${retryAfter} soniya kutilmoqda... (Urinish: ${retryCount + 1})`);
                await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
                return bot.sendMessage(chatId, text, options, retryCount + 1);
            }
        }

        // Entity offset (UTF-16) — premium emoji + markdown aralashganda
        if (
            retryCount < 2 &&
            (error.message.includes('UTF-16') ||
                error.message.includes('entity beginning') ||
                error.message.includes('ENTITY_CUSTOM_EMOJI_FORBIDDEN'))
        ) {
            if (error.message.includes('ENTITY_CUSTOM_EMOJI_FORBIDDEN')) {
                console.log(`⚠️ [Premium Emoji Forbidden] Custom emojilarsiz yuborilmoqda...`);
            } else {
                console.log(`⚠️ [Entity offset] Oddiy matn bilan qayta yuborilmoqda...`);
            }
            const plainText = text ? text.toString().replace(/\*\*/g, '').replace(/`/g, '') : 'Xatolik yuz berdi';
            const fallbackOptions = { ...sendOptions };
            delete fallbackOptions.parse_mode;
            delete fallbackOptions.entities;
            return await baseSendMessage(chatId, plainText, fallbackOptions);
        }
        
        console.error(`❌ [bot.sendMessage Error] to ${chatId}:`, error.message);
        
        // Oxirgi chora: mutlaqo oddiy matn ko'rinishida, lekin tugmalarni saqlab qolgan holda
        if (retryCount === 0) {
            try {
                const safeText = text ? text.toString().replace(/[_*`]/g, '') : "Xatolik yuz berdi";
                const fallbackOptions = { ...options };
                delete fallbackOptions.parse_mode;
                delete fallbackOptions.entities;
                return await baseSendMessage(chatId, safeText, fallbackOptions);
            } catch (e) {
                const isFallbackExpected = 
                    e.response && 
                    e.response.statusCode && 
                    [400, 403, 404].includes(e.response.statusCode);
                if (isFallbackExpected) {
                    console.log(`⚠️ [Expected Error] Xabar yuborib bo'lmadi (${chatId}): ${e.message}`);
                } else {
                    console.error("Fallback sendMessage error:", e.message);
                }
            }
        }
        // Kutilmagan xatolar uchun, ammo 400/403/404 bo'lsa qaytarmaslik
        if (!isExpectedError) {
            throw error;
        }
        return null;
    }
};

const baseEditMessageText = bot.editMessageText.bind(bot);
bot.editMessageText = async (text, options = {}, retryCount = 0) => {
    try {
        if (!text) return;
        const { cleanText, entities } = withPremiumEmojis(text);
        let finalOptions = { ...options };
        let finalText = text;

        if (entities && entities.length > 0) {
            finalOptions.entities = entities;
            delete finalOptions.parse_mode; 
            finalText = cleanText;
        }

        return await baseEditMessageText(finalText, finalOptions);
    } catch (error) {
        if (error.message.includes("message is not modified")) return;
        
        if (error.code === 'ETELEGRAM' && error.response && error.response.body && error.response.body.parameters) {
            const retryAfter = error.response.body.parameters.retry_after;
            if (retryAfter && retryCount < 3) {
                console.log(`⚠️ [429 Flood] bot.editMessageText uchun ${retryAfter} soniya kutilmoqda... (Urinish: ${retryCount + 1})`);
                await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
                return bot.editMessageText(text, options, retryCount + 1);
            }
        }

        // Premium emoji xatosi uchun handling
        if (error.message.includes('ENTITY_CUSTOM_EMOJI_FORBIDDEN') && retryCount < 2) {
            const { cleanText, entities } = withPremiumEmojis(text);
            const standardEntities = entities.filter(e => e.type !== 'custom_emoji');
            return await baseEditMessageText(cleanText, { ...options, entities: standardEntities, parse_mode: undefined });
        }
        
        console.error(`❌ [bot.editMessageText Error]:`, error.message);
        
        if (retryCount === 0) {
            try {
                const safeText = text.toString().replace(/[_*`]/g, '');
                const fallbackOptions = { ...options };
                delete fallbackOptions.parse_mode;
                delete fallbackOptions.entities;
                return await baseEditMessageText(safeText, fallbackOptions);
            } catch (e) {
                console.error("Fallback editMessage error:", e.message);
            }
        }
        throw error;
    }
};

const baseAnswerCallbackQuery = bot.answerCallbackQuery.bind(bot);
bot.answerCallbackQuery = async (callbackQueryId, options = {}, retryCount = 0) => {
    try {
        return await baseAnswerCallbackQuery(callbackQueryId, options);
    } catch (error) {
        if (error.message.includes("query is too old") || error.message.includes("query ID is invalid")) return;
        if (error.code === 'ETELEGRAM' && error.response && error.response.body && error.response.body.parameters) {
            const retryAfter = error.response.body.parameters.retry_after;
            if (retryAfter && retryCount < 2) {
                await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
                return bot.answerCallbackQuery(callbackQueryId, options, retryCount + 1);
            }
        }
        console.error(`❌ [bot.answerCallbackQuery Error]:`, error.message);
    }
};

// Pollingni xavfsiz boshlash funksiyasi
const startPolling = async () => {
    try {
        // Eski webhooklarni tozalash
        await bot.deleteWebHook({ drop_pending_updates: true });
        console.log("Sweep: Eski sessiyalar va webhooklar tozalandi.");
        
        // Pollingni boshlash
        bot.startPolling();
        console.log("🤖 Polling boshlandi...");
    } catch (err) {
        console.error("❌ Pollingni boshlashda xato:", err.message);
        setTimeout(startPolling, 5000);
    }
};

// Polling error handling
bot.on('polling_error', (error) => {
    if (error.message.includes('409 Conflict')) {
        console.error("⚠️ [409 Conflict] Bot boshqa joyda ham ishlamoqda. Eski sessiya hali yopilmagan bo'lishi mumkin.");
        // 409 bo'lganda pollingni to'xtatib, birozdan keyin qayta boshlaymiz
        bot.stopPolling().then(() => {
            setTimeout(startPolling, 10000);
        });
    } else {
        console.error("Polling error:", error.message);
    }
});

// --- 4. HANDLERS INTEGRATION --- 
require('./handlers/commands')(bot); 
require('./handlers/callbacks')(bot); 
require('./handlers/messages')(bot); 

// Debug: Xabar kelayotganini tekshirish
bot.on('message', (msg) => {
    console.log(`📩 Xabar keldi [${msg.chat.id}]: ${msg.text || '[Media/Other]'}`);
});

// --- 3. DATABASE CONNECTION & RESTORE ---
const initBot = async () => {
    try {
        setDbReady(false);
        console.log('🔄 Initializing bot...');
        await restoreDB();
        await connectDB();

        const needsReconnect = await verifyDatabaseAfterConnect();
        if (needsReconnect) {
            await reconnectDB();
        }

        const { migrateSchema } = require('./config/migrate');
        await migrateSchema();
        setDbReady(true);

        await runExpirySweep(bot, { reason: 'zaxira_tiklash', backupOnChange: true });

        startExpiryChecker();

        await startPolling();
        loadAllStates(bot);
        startBackupScheduler();

        setTimeout(() => triggerBackup('ishga_tushish', true), 15000);
    } catch (err) {
        console.error("Critical error in initBot chain:", err);
        setDbReady(false);
    }
};

initBot();

// --- GRACEFUL SHUTDOWN (Render Deploy uchun) ---
const shutdown = async (signal) => {
    console.log(`\n Industrial shutdown (${signal})...`);
    setDbReady(false);
    try {
        try {
            await sequelize.query('PRAGMA wal_checkpoint(FULL)');
        } catch (e) {}
        await backupDB('server_to_xtadi');
        await bot.stopPolling();
        console.log("🛑 Polling to'xtatildi.");
        await sequelize.close();
        console.log("🔌 SQLite ulanishi yopildi.");
        process.exit(0);
    } catch (err) {
        console.error("Shutdown error:", err.message);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT')); 

// Global states 
global.userStates = {}; 

// --- REAL-TIME EXPIRY (faqat DB tayyor bo'lgach) ---
const startExpiryChecker = () => {
    if (global._expiryCheckerStarted) return;
    global._expiryCheckerStarted = true;

    setInterval(async () => {
        if (!getDbReady()) return;

        try {
            const now = new Date();
            const { Op } = require('sequelize');

            await runExpirySweep(bot, { reason: 'periodic', backupOnChange: true });

            const oneDayLater = new Date(now.getTime() + 86400000);
            const warningUsers = await User.findAll({
                where: {
                    status: 'approved',
                    expireAt: {
                        [Op.gt]: now,
                        [Op.lt]: oneDayLater
                    },
                    expiryWarningSent: false
                }
            });
            for (const u of warningUsers) {
                const warningText = `⚠️ **Diqqat!**\n\nSizning botdan foydalanish muddatingiz tugashiga **1 kun** qoldi. Botdan foydalanishni davom ettirish uchun to'lovni amalga oshiring.\n\n👨‍💼 Admin: @ortiqov_x7`;
                bot.sendMessage(u.chatId, warningText, { parse_mode: "Markdown", skipEmojiWrap: true });
                await User.update({ expiryWarningSent: true }, { where: { chatId: u.chatId } });
            }
        } catch (error) {
            const msg = error.message || String(error);
            if (msg.includes('no such table')) {
                console.error('Expiry checker: users jadvali yo\'q, schema tiklanmoqda...');
                setDbReady(false);
                try {
                    await ensureSchema();
                    setDbReady(true);
                } catch (e) {
                    console.error('ensureSchema xatosi:', e.message);
                }
                return;
            }
            console.error('Expiry checker error:', error);
        }
    }, 60000);
};

const hostName = os.hostname();
const startTime = new Date().toLocaleString('en-US');
const startupMessage = `🚀 **Bot ishga tushdi!**\n\n💻 **Host:** ${hostName}\n📅 **Vaqt:** ${startTime}`;

if (config.adminId) {
    bot.sendMessage(config.adminId, startupMessage, { parse_mode: "Markdown" }).catch(err => {
        console.error("Admin startup notification error:", err.message);
    });
}

console.log(`🚀 AVTOCLICK PRO Ishga tushdi (Host: ${hostName})!`);

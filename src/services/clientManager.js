/**
 * Client Manager
 * Userbot clientlarni boshqarish + Avto Almaz handlerlari
 * (Kodlar originaldan o'zgartirilmasdan ko'chirilgan)
 */

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const config = require("../config");
const User = require("../models/User");
const {
    userClients,
    avtoAlmazStates,
    utagStates,
    scrapeSessions,
    getUser,
    updateStats,
    blockExpiredUser
} = require("./userbotState");

const getGramJsClientParams = (useWSS, { forAuth = false } = {}) => ({
    connectionRetries: forAuth ? 10 : 5, // Fewer retries for regular userbots
    requestRetries: 3,
    timeout: forAuth ? 120000 : 30000, // Shorter timeout for regular use
    autoReconnect: !forAuth,
    floodSleepThreshold: forAuth ? 120 : 300,
    receiveUpdates: false, // Never receive updates for userbots (faster & lighter)
    deviceModel: config.tgDeviceModel,
    systemVersion: config.tgSystemVersion,
    appVersion: config.tgAppVersion,
    langCode: 'en',
    systemLangCode: 'en-US',
    useWSS: true, // ALWAYS use WSS (port 443) for better Render compatibility
    useIPV6: false
});

// --- YANGI: Holatlarni bazadan yuklash va botlarni ishga tushirish ---
const loadAllStates = async (bot) => {
    try {
        const { withMigrationRetry } = require('../config/migrate');
        const users = await withMigrationRetry(() =>
            User.findAll({ where: { session: { [require('sequelize').Op.ne]: null }, status: 'approved' } })
        );
        const now = new Date();
        const activeUsers = users.filter((u) => !u.expireAt || new Date(u.expireAt) >= now);
        console.log(`🔄 [Init] ${activeUsers.length} ta foydalanuvchi botlarini ishga tushirish...`);
        for (const user of activeUsers) {
            avtoAlmazStates[user.chatId] = user.avtoAlmaz !== false;
            // Har bir foydalanuvchi uchun userbotni ishga tushiramiz
            startUserbot(user.chatId, user.session, bot).catch(e => {
                console.error(`[AutoStart Error] ${user.chatId}:`, e.message);
            });
            // Render free: parallel ulanishlar TIMEOUT beradi — kutish
            await new Promise(r => setTimeout(r, 3000)); 
        }
        console.log(`✅ [States] ${activeUsers.length} ta foydalanuvchi holati yuklandi va botlar ishga tushirildi.`);
    } catch (e) {
        console.error('loadAllStates error:', e.message);
    }
};

const startUserbot = async (chatId, sessionStr, bot) => { 
    try { 
        // Agar faol yig'ish sessiyasi mavjud bo'lsa, hech narsa qilmaymiz!
        if (scrapeSessions[chatId]) {
            console.log(`⏳ User ${chatId} uchun faol yig'ish sessiyasi mavjud, startUserbot o'tkazib yuborildi.`);
            // Faqat avto almaz holatini yangilaymiz
            if (avtoAlmazStates[chatId] === undefined) { 
                const user = await getUser(chatId); 
                avtoAlmazStates[chatId] = user && user.avtoAlmaz !== undefined ? user.avtoAlmaz : true; 
            }
            return;
        }
        
        if (userClients[chatId]) {
            try { await userClients[chatId].disconnect(); } catch (e) {}
        }

        const clientOpts = getGramJsClientParams(true, { forAuth: false }); // Always use WSS
        if (config.telegramProxy?.host) {
            clientOpts.proxy = {
                ip: config.telegramProxy.host,
                port: config.telegramProxy.port,
                secret: config.telegramProxy.secret,
                MTProxy: true
            };
        }
        const client = new TelegramClient(new StringSession(sessionStr), config.apiId, config.apiHash, clientOpts);
        
        // Don't crash the whole bot if one userbot fails to connect
        try {
            await client.connect(); 
            userClients[chatId] = client; 
            console.log("✅ Userbot " + chatId + " uchun ishga tushdi."); 
        } catch (connectError) {
            console.error(`❌ Userbot ${chatId} ulanishda xato:`, connectError.message);
            return;
        }
    
        // Default holat: Bazadan olish 
        if (avtoAlmazStates[chatId] === undefined) { 
            const user = await getUser(chatId); 
            avtoAlmazStates[chatId] = user && user.avtoAlmaz !== undefined ? user.avtoAlmaz : true; 
        } 

        // Ulanish holatini kuzatish (butun botni chalg'itmaslik uchun)
        client.on('disconnected', () => {
            console.log(`ℹ️ Userbot ${chatId} ulanish uzildi. Qayta ulanish kutilmoqda...`);
        });
        
        client.on('reconnected', () => {
            console.log(`✅ Userbot ${chatId} qayta ulandi.`);
        });
        
        // GramJS WebSocket timeout xatolarini suppress qilamiz (avtomatik qayta ulanish bor)
        client.on('error', (err) => {
            const msg = err?.message || '';
            if (msg.includes('ETIMEDOUT') || msg.includes('WebSocket') || msg.includes('Connection')) {
                console.log(`ℹ️ Userbot ${chatId}: Ulanish bilan bog'liq muammo (avtomatik tiklanadi)`);
            } else if (!msg.includes('FLOOD')) {
                console.error(`⚠️ Userbot ${chatId} xatosi:`, msg);
            }
        });        

        // --- YANGI: XABARLARNI ESHITISH (Bot guruhda bo'lmasa ham ishlashi uchun) ---
        client.addEventHandler(async (event) => {
            const message = event.message;
            if (!message || !message.message) return;

            const text = message.message;
            const fromId = message.senderId ? message.senderId.toString() : null;
            
            // Peer ID ni aniqlash
            let peerStr;
            if (message.peerId instanceof Api.PeerUser) peerStr = message.peerId.userId.toString();
            else if (message.peerId instanceof Api.PeerChat) peerStr = `-${message.peerId.chatId}`;
            else if (message.peerId instanceof Api.PeerChannel) peerStr = `-100${message.peerId.channelId}`;

            // Faqat akkaunt egasi yuborgan buyruqlarni tekshiramiz (/uteg yoki .uteg)
            const isOwner = fromId === chatId.toString();
            const isCommand = /^[./!]?(t|b|s)(@|$)/i.test(text);

            if (isOwner && isCommand) {
                const parts = text.split(/\s+/);
                const rawCommand = parts[0].toLowerCase();
                const base = rawCommand.replace(/^[./!]/, '').split('@')[0];
                const aliasMap = {
                    t: 'uteg',
                    b: 'utegtext',
                    s: 'utegstop'
                };
                const command = aliasMap[base] || base;

                try {
                    // 1. Foydalanuvchi obunasini tekshirish
                    const { checkMembership } = require('../utils/helpers');
                    const isMember = await checkMembership(bot, chatId);
                    if (!isMember) return;

                    // 2. Statusni tekshirish
                    const user = await User.findOne({ where: { chatId } });
                    if (!user || user.status !== 'approved') return;

                    // 3. Akkaunt rejimini tekshirish (agar o'rnatilmagan bo'lsa)
                    if (!user.utagAccountMode) {
                        await client.sendMessage(message.peerId, { message: "⚠️ **Avto Utag rejimi o'rnatilmagan.**\nIltimos, botga kirib rejimni tanlang (Asosiy menyu -> Avto Utag)." });
                        return;
                    }

                    if (message.peerId instanceof Api.PeerUser) {
                        await client.sendMessage(message.peerId, {
                            message: "⚠️ Utag buyruqlarini **guruh yoki kanalda** yuboring (shaxsiy chatda emas)."
                        });
                        return;
                    }

                    const { startAutoTag } = require('./tagging/utagService');

                    // --- BUYRUQLAR ---
                    if (command === 'utegstop') {
                        if (utagStates[chatId]) {
                            utagStates[chatId].status = 'stopped';
                            await client.sendMessage(message.peerId, { message: "⏹ **Utag to'xtatildi.**" });
                        }
                        return;
                    }

                    if (command === 'utegtext') {
                        await client.sendMessage(message.peerId, { message: "🚀 **Utag (bot so'zlari) boshlanmoqda...**" });
                        startAutoTag(chatId, peerStr, bot, {
                            limit: 0, mode: 'random_words', memberFilter: 'all', isCommand: true
                        }).catch((e) => client.sendMessage(message.peerId, { message: `❌ ${e.message}` }));
                        return;
                    }

                    if (command === 'uteg') {
                        const args = parts.slice(1).join(' ').trim();
                        if (args) {
                            await client.sendMessage(message.peerId, { message: `🚀 **Utag ("${args}" bilan) boshlanmoqda...**` });
                            startAutoTag(chatId, peerStr, bot, {
                                limit: 0, mode: 'custom', tagText: args, memberFilter: 'all', isCommand: true
                            }).catch((e) => client.sendMessage(message.peerId, { message: `❌ ${e.message}` }));
                        } else {
                            await client.sendMessage(message.peerId, { message: "🚀 **Utag (faqat @) boshlanmoqda...**" });
                            startAutoTag(chatId, peerStr, bot, {
                                limit: 0, mode: 'only_mention', memberFilter: 'all', isCommand: true
                            }).catch((e) => client.sendMessage(message.peerId, { message: `❌ ${e.message}` }));
                        }
                    }
                } catch (e) {
                    console.error(`[Userbot Command Error] ${chatId}:`, e.message);
                }
            }
        }, new NewMessage({}));

        // GramJS xatolarini ushlash
        client.on('error', (err) => {
            const msg = err.message || '';
            if (msg.includes('Not connected') || msg.includes('TIMEOUT')) {
                console.log(`[GramJS] User ${chatId}: ${msg} (qayta ulanish kutilmoqda)`);
            } else if (!msg.includes('FLOOD')) {
                console.error(`[GramJS Error] User ${chatId}:`, msg);
            }
        });

        console.log(`✅ Userbot ulandi: ${chatId}`);

        // --- AVTO ALMAZ HANDLER (USER INPUT) ---
        client.addEventHandler(async (event) => { 
            const message = event.message; 
            if (!message) return;

            // Real-time muddat tekshirish (faqat admin bo'lmasa) 
            if (chatId.toString() !== config.adminId.toString()) { 
                const user = await getUser(chatId); 
                if (user && user.status === 'approved' && user.expireAt) { 
                    const now = new Date(); 
                    if (user.expireAt < now) { 
                        console.log(`[Real-time Userbot Expiry] User ${chatId} muddati tugagan.`); 
                        await blockExpiredUser(user, bot); 
                        return; 
                    } 
                } 
            } 

            // Agar funksiya o'chirilgan bo'lsa, ishlamaydi 
            if (avtoAlmazStates[chatId] === false) return; 
            
            // Faqat tugmasi bor xabarlarni tekshiramiz 
            if (message && message.buttons && message.buttons.length > 0) { 
                let clicked = false; 
                
                const rows = message.buttons; 
                for (let i = 0; i < rows.length; i++) { 
                    const row = rows[i]; 
                    for (let j = 0; j < row.length; j++) { 
                        const button = row[j]; 
                        
                        if (button.text) { 
                            const btnText = button.text; 
                            
                            // Regex orqali istalgan miqdordagi almaz/sovg'ani/pulni aniqlash 
                            if ( 
                                /^\d+\s*[💎🎁💵].*olish$/i.test(btnText) || // "10 💎 olish", "100 💵 olish" 
                                btnText === 'olish' || 
                                btnText === 'клик' || 
                                btnText === 'click' || 
                                btnText === 'Click' || 
                                btnText === 'Bosing' || 
                                btnText === 'bosing' ||
                                btnText == '💎  ta olmos olish' ||
                                btnText == '🎁 olish'

                             ) { 
                                console.log("[" + chatId + "] Tugma topildi (Dynamic): " + btnText); 
                                try { 
                                    // Tugmani darhol bosamiz (await kutmasdan, parallel) 
                                    message.click(i, j).then(async () => { 
                                        console.log("[" + chatId + "] Tugma bosildi!"); 
                                        
                                        // Statistikani ham parallel yangilaymiz 
                                        updateStats(chatId).catch(err => console.error("Stats update error:", err)); 

                                        // Xabar yuborish (Non-blocking) 
                                        try { 
                                            const user = await getUser(chatId); 
                                            const totalClicks = user ? (user.clicks + 1) : 1; // +1 chunki updateStats parallel ketyapti 

                                            let chatTitle = "Noma'lum guruh"; 
                                            try { 
                                                const chat = await message.getChat(); 
                                                chatTitle = chat.title || chat.firstName || "Guruh"; 
                                            } catch (e) {} 

                                            // Xabar turini aniqlash 
                                            let rewardText = "1 almaz olindi 💎"; 
                                            if (btnText.includes('💵')) { 
                                                rewardText = "Pul olindi 💵"; 
                                            } 

                                            bot.sendMessage(chatId, "💎 **Avto Almaz:** " + rewardText + "\n" + chatTitle + "\n\nJami: " + totalClicks + " ta", { parse_mode: "Markdown" }); 
                                        } catch (e) { 
                                            console.error("Xabar yuborishda xatolik:", e); 
                                        } 

                                    }).catch(err => { 
                                        console.error("Tugmani bosishda xatolik:", err); 
                                    }); 
                                    
                                    clicked = true; 
                                    break; 
                                } catch (err) { 
                                    console.error("Tugmani bosishda xatolik:", err); 
                                } 
                            } 
                        } 
                    } 
                    if (clicked) break; 
                } 
            } 
        }, new NewMessage({})); 

        // Tahrirlangan xabarlar uchun (ba'zi botlar tugmalarni tahrirlangan xabarda yuboradi)
        client.addEventHandler(async (update) => {
            try {
                if (update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage) {
                    const message = update.message;
                    if (message && message.buttons && message.buttons.length > 0) {
                        // O'sha mantiqni tahrirlangan xabarlar uchun ham qo'llaymiz
                        let clicked = false;
                        const rows = message.buttons;
                        for (let i = 0; i < rows.length; i++) {
                            const row = rows[i];
                            for (let j = 0; j < row.length; j++) {
                                const button = row[j];
                                if (button.text) {
                                    const btnText = button.text;
                                    if ( 
                                        /^\d+\s*[💎🎁💵].*olish$/i.test(btnText) || 
                                        btnText === 'olish' || 
                                        btnText === 'клик' || 
                                        btnText === 'click' || 
                                        btnText === 'Click' || 
                                        btnText === 'Bosing' || 
                                        btnText === 'bosing' ||
                                        btnText == '💎  ta olmos olish' ||
                                        btnText == '🎁 olish'
                                     ) {
                                        message.click(i, j).catch(() => {});
                                        clicked = true;
                                        break;
                                    }
                                }
                            }
                            if (clicked) break;
                        }
                    }
                }
            } catch (e) {}
        });

    } catch (e) { console.error(`Userbot xatosi (${chatId}):`, e.message); } 
}; 

const attachAlmazHandlers = (client, chatId, bot) => {
    client.addEventHandler(async (event) => {
        const message = event.message;
        if (!message) return;
        if (chatId.toString() !== config.adminId.toString()) {
            const user = await getUser(chatId);
            if (user?.status === 'approved' && user.expireAt && user.expireAt < new Date()) {
                await blockExpiredUser(user, bot);
                return;
            }
        }
        if (avtoAlmazStates[chatId] === false) return;
        if (!message.buttons?.length) return;
        for (let i = 0; i < message.buttons.length; i++) {
            const row = message.buttons[i];
            for (let j = 0; j < row.length; j++) {
                const btnText = row[j]?.text;
                if (!btnText) continue;
                if (/^\d+\s*[💎🎁💵].*olish$/i.test(btnText) || ['olish', 'клик', 'click', 'Click', 'Bosing', 'bosing'].includes(btnText)) {
                    message.click(i, j).then(async () => {
                        updateStats(chatId).catch(() => {});
                        const u = await getUser(chatId);
                        const totalClicks = u ? u.clicks + 1 : 1;
                        let chatTitle = "Guruh";
                        try {
                            const chat = await message.getChat();
                            chatTitle = chat.title || chat.firstName || "Guruh";
                        } catch (e) {}
                        const rewardText = btnText.includes('💵') ? "Pul olindi 💵" : "1 almaz olindi 💎";
                        bot.sendMessage(chatId, "💎 **Avto Almaz:** " + rewardText + "\n" + chatTitle + "\n\nJami: " + totalClicks + " ta", { parse_mode: "Markdown" });
                    }).catch(() => {});
                    return;
                }
            }
        }
    }, new NewMessage({}));

    client.addEventHandler(async (update) => {
        if (!(update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage)) return;
        const message = update.message;
        if (!message?.buttons?.length) return;
        for (let i = 0; i < message.buttons.length; i++) {
            const row = message.buttons[i];
            for (let j = 0; j < row.length; j++) {
                const btnText = row[j]?.text;
                if (!btnText) continue;
                if (
                    /^\d+\s*[💎🎁💵].*olish$/i.test(btnText) ||
                    ['olish', 'клик', 'click', 'Click', 'Bosing', 'bosing', '💎 1 ta olmos olish', '1🎁 olish'].includes(btnText)
                ) {
                    message.click(i, j).catch(() => {});
                    return;
                }
            }
        }
    });
};

const ensureClient = async (chatId, bot) => {
    if (userClients[chatId] && userClients[chatId].connected) return userClients[chatId];
    
    const user = await User.findOne({ where: { chatId } });
    if (!user || !user.session) throw new Error("Asosiy akkaunt ulanmagan.");
    
    await startUserbot(chatId, user.session, bot);
    return userClients[chatId];
};

module.exports = {
    getGramJsClientParams,
    loadAllStates,
    startUserbot,
    attachAlmazHandlers,
    ensureClient
};
 
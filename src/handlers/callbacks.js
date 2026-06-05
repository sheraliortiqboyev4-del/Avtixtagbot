const User = require('../models/User');
const Channel = require('../models/Channel');
const config = require('../config');
const { sequelize, getDbReady } = require('../config/db');
const { findUserByChatId } = require('../utils/dbUser');
const { triggerBackup } = require('../utils/dbBackup');
const { 
    getAdminMenu, 
    getMainMenu, 
    getAlmazMenu,
    checkMembership,
    getPendingPaymentKeyboard
} = require('../utils/helpers');

if (!global.userStates) global.userStates = {};

// Admin ro'yxatlari uchun sahifa o'lchami (rasmdagidek)
const ADMIN_LIST_PAGE_SIZE = 10;

// Bitta foydalanuvchi yozuvini rasmdagi ko'rinishda formatlash
const STATUS_ICON = { approved: '✅', pending: '⏳', blocked: '🚫' };
const formatUserRow = (u) => {
    const icon = STATUS_ICON[u.status] || '⏳';
    const namePart = u.username
        ? `${u.name || "Noma'lum"} (@${u.username}) ${icon}`
        : `${u.name || "Noma'lum"} ${icon}`;
    const joined = u.joinedAt ? new Date(u.joinedAt) : new Date();
    const dateStr = `${joined.getFullYear()}-${String(joined.getMonth() + 1).padStart(2, '0')}-${String(joined.getDate()).padStart(2, '0')} ${String(joined.getHours()).padStart(2, '0')}:${String(joined.getMinutes()).padStart(2, '0')}`;
    return `👤 ${namePart}\n🆔 ${u.chatId} | /info_${u.chatId}\n📅 ${dateStr}`;
};

// Sahifalangan ro'yxat matni va tugmalarini tayyorlash
const buildUserListPage = (users, page, title, backCallback) => {
    const totalPages = Math.max(1, Math.ceil(users.length / ADMIN_LIST_PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const start = safePage * ADMIN_LIST_PAGE_SIZE;
    const pageUsers = users.slice(start, start + ADMIN_LIST_PAGE_SIZE);

    let text = `👥 ${title}: (Sahifa ${safePage + 1}/${totalPages})\n\n`;
    if (pageUsers.length === 0) {
        text += "Hozircha hech kim yo'q.";
    } else {
        text += pageUsers.map(formatUserRow).join("\n\n");
    }

    const navRow = [];
    if (safePage > 0) navRow.push({ text: "⬅️ Orqaga", callback_data: `${backCallback}_page_${safePage - 1}` });
    if (safePage < totalPages - 1) navRow.push({ text: "Keyingi ➡️", callback_data: `${backCallback}_page_${safePage + 1}` });

    const keyboard = [];
    if (navRow.length > 0) keyboard.push(navRow);
    keyboard.push([{ text: "🏠 Admin Panel", callback_data: "admin_panel" }]);

    return { text, reply_markup: { inline_keyboard: keyboard } };
};

module.exports = (bot) => {
    // Helper function to safely edit messages and handle "message is not modified" error
    const safeEdit = async (chatId, messageId, text, options = {}, isMarkupOnly = false) => {
        try {
            if (isMarkupOnly) {
                return await bot.editMessageReplyMarkup(options.reply_markup, { chat_id: chatId, message_id: messageId });
            }
            return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        } catch (error) {
            if (error.message.includes("message is not modified")) {
                // Ignore this error as it's harmless
                return;
            }
            console.error("Edit message error:", error.message);
            throw error;
        }
    };

    bot.on('callback_query', async (query) => { 
        const chatId = query.message.chat.id; 
        const data = query.data; 
        const messageId = query.message.message_id;

        // Helper to answer callback safely
        const safeAnswer = async (options = {}) => {
            try {
                await bot.answerCallbackQuery(query.id, options);
            } catch (e) {
                // Ignore timeout/invalid query errors
                if (!e.message.includes("query is too old") && !e.message.includes("query ID is invalid")) {
                    console.error("answerCallbackQuery error:", e.message);
                }
            }
        };

        if (!getDbReady()) {
            await safeAnswer({ text: '⏳ Bot yuklanmoqda, 5 soniyadan keyin qayta urinib ko\'ring.', show_alert: true });
            return;
        }

        // --- 1. SESSION CHECK ---
        const user = await findUserByChatId(chatId);
        const allowedCallbacks = [
            "check_subscription",
            "menu_back_main",
            "auth_resend_sms",
            "auth_resend_app"
        ];
        const isAdminAction = data.startsWith("admin_");
        
        if (!isAdminAction && !allowedCallbacks.includes(data)) {
            if (!user || !user.session) {
                await safeAnswer({ 
                    text: "⚠️ Botdan foydalanish uchun avval Telegram akkauntingiz bilan tizimga kiring. /start ni bosing.", 
                    show_alert: true 
                });
                return;
            }
        }

        if (data === "auth_resend_app" || data === "auth_resend_sms") {
            const { resendAuthCode } = require('../services/userbot');
            try {
                await resendAuthCode(chatId, bot, false);
                return await safeAnswer({ text: "Kod qayta so'raldi" });
            } catch (e) {
                return await safeAnswer({ text: e.message, show_alert: true });
            }
        }

        // --- 2. SUBSCRIPTION CHECK ---
        const isMember = await checkMembership(bot, chatId);
        if (!isMember && data !== "check_subscription") {
            await safeAnswer({ text: "⚠️ Botdan foydalanish uchun avval kanallarga a'zo bo'ling!", show_alert: true });
            return sendSubscriptionAsk(bot, chatId);
        }

        if (data === "check_subscription") {
            const isMemberNow = await checkMembership(bot, chatId);
            if (isMemberNow) {
                try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
                await bot.sendMessage(
                    chatId,
                    "✅ **Rahmat!** Siz barcha kanallarga a'zo bo'ldingiz.\n\n/start ni bosing.",
                    { parse_mode: "Markdown" }
                );
            } else {
                await safeAnswer({ text: "❌ Siz hali barcha kanallarga a'zo bo'lmadingiz!", show_alert: true });
            }
            return;
        }

        // --- 2. MENU NAVIGATION ---
        if (data === "menu_back_main") {
            const u = await User.findOne({ where: { chatId } });
            if (!u || !u.session) {
                await safeEdit(chatId, messageId, "📋 **Menyu:**", {
                    parse_mode: "Markdown"
                });
            } else {
                await safeEdit(chatId, messageId, "📋 **Asosiy menyu:**", { parse_mode: "Markdown", ...getMainMenu(chatId) });
            }
            return await safeAnswer();
        }

        if (data === "menu_almaz") {
            const isEnabled = user.avtoAlmaz;
            const statusText = isEnabled ? "🟢 Yoqilgan" : "🔴 O'chirilgan";
            
            const text = `💎 **Avto Almaz**\n\n🤖 Bot guruhlarga yuborilgan almaz va pullarni avto yig'adi.\n\nEslatma!! Almaz va pullar mafia botdagi xisobingizga qo'shiladi.\n\n⚙ Holati: ${statusText}`;
            
            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                ...getAlmazMenu(isEnabled)
            });
            return await safeAnswer();
        }

        if (data === "almaz_on" || data === "almaz_off") {
            const isEnabled = data === "almaz_on";
            await User.update({ avtoAlmaz: isEnabled }, { where: { chatId } });

            const { avtoAlmazStates } = require('../services/userbot');
            avtoAlmazStates[chatId] = isEnabled;
            
            const statusText = isEnabled ? "🟢 Yoqilgan" : "🔴 O'chirilgan";
            const text = `💎 **Avto Almaz**\n\n🤖 Bot guruhlarga yuborilgan almaz va pullarni avto yig'adi.\n\nEslatma!! Almaz va pullar mafia botdagi xisobingizga qo'shiladi.\n\n⚙ Holati: ${statusText}`;
            
            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                ...getAlmazMenu(isEnabled)
            });
            
            return await safeAnswer({ text: `Avto Almaz ${isEnabled ? "yoqildi" : "o'chirildi"}.`, show_alert: false });
        }

        if (data === "menu_avtouser") {
            await safeEdit(chatId, messageId, "👥 **Avto User**\n\nQaysi usulda user yig'moqchisiz?", {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "👥 Faol azolarni yig'ish", callback_data: "avtouser_active" }],
                        [{ text: "🏷 Mention azolarni yig'ish", callback_data: "avtouser_mention" }],
                        [{ text: "🔙 Orqaga", callback_data: "menu_back_main" }]
                    ]
                }
            });
            return await safeAnswer();
        }

        if (data === "avtouser_active" || data === "avtouser_mention") {
            const { getAvtoUserGroupPickerKeyboard } = require('../utils/helpers');
            const type = data === "avtouser_active" ? "active" : "mention";
            global.userStates[chatId] = { step: 'WAITING_AVTOUSER_GROUP', type };
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            await bot.sendMessage(
                chatId,
                "🔗 **Guruh linkini yuboring yoki tanlang.**",
                { parse_mode: "Markdown", reply_markup: getAvtoUserGroupPickerKeyboard() }
            );
            return await safeAnswer();
        }

        if (data === "scrape_stop") {
            const { scrapeSessions } = require('../services/userbot');
            if (scrapeSessions[chatId]) {
                scrapeSessions[chatId].status = 'stopped';
                await safeAnswer({ text: "⏹ To'xtatilmoqda..." });
            } else {
                await safeAnswer({ text: "❌ Faol jarayon topilmadi.", show_alert: true });
            }
            return;
        }
        
        if (data.startsWith("avtouser_limit_")) {
            const state = global.userStates[chatId];
            if (!state || state.step !== 'WAITING_AVTOUSER_LIMIT') {
                return await safeAnswer({ text: "Sessiya muddati tugagan.", show_alert: true });
            }
            const historyLimit = parseInt(data.split('_')[2], 10);
            delete global.userStates[chatId];
            await safeAnswer({ text: "⏳ Userlarni yig'ish boshlandi..." });
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            
            const { scrapeUsers, scrapeMentionUsers } = require('../services/userbot');
            
            // Don't send another message, scrapeUsers already sends one
            
            if (state.type === 'active') {
                scrapeUsers(chatId, state.groupLink, 2000, bot).catch(err => {
                    bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
                });
            } else {
                scrapeMentionUsers(chatId, state.groupLink, historyLimit, bot).catch(err => {
                    bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
                });
            }
            return;
        }

        if (data === "menu_reyd") {
            const { getReydMenu } = require('../utils/helpers');
            const mode = user.reydAccountMode || 'main';
            const accCount = user.reydAccounts ? user.reydAccounts.length : 0;
            const modeText = mode === 'all' ? "Barcha akkauntlar" : "Faqat asosiy akkaunt";
            const text = `⚔️ **Reyd bo'limi**\n\n⚙️ Hozirgi rejim: **${modeText}**\n👥 Akkauntlar: **${accCount + 1} ta**\n\nSiz bir nechta akkaunt ulab, reydni yanada tezroq va samaraliroq amalga oshirishingiz mumkin. Akkauntlar navbatma-navbat xabar yuboradi.`;
            
            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                ...getReydMenu(mode, accCount)
            });
            return await safeAnswer();
        }

        if (data === "reyd_change_mode") {
            const currentMode = user.reydAccountMode || 'main';
            const newMode = currentMode === 'all' ? 'main' : 'all';
            await User.update({ reydAccountMode: newMode }, { where: { chatId } });
            
            const { getReydMenu } = require('../utils/helpers');
            const accCount = user.reydAccounts ? user.reydAccounts.length : 0;
            const modeText = newMode === 'all' ? "Barcha akkauntlar" : "Faqat asosiy akkaunt";
            const text = `⚔️ **Reyd bo'limi**\n\n⚙️ Hozirgi rejim: **${modeText}**\n👥 Akkauntlar: **${accCount + 1} ta**\n\nSiz bir nechta akkaunt ulab, reydni yanada tezroq va samaraliroq amalga oshirishingiz mumkin. Akkauntlar navbatma-navbat xabar yuboradi.`;
            
            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                ...getReydMenu(newMode, accCount)
            });
            return await safeAnswer({ text: `Rejim o'zgartirildi: ${modeText}` });
        }

        if (data.startsWith("reyd_set_mode_")) {
            const mode = data.replace('reyd_set_mode_', ''); // main or all
            await User.update({ reydAccountMode: mode }, { where: { chatId } });
            await safeAnswer({ text: `Rejim eslab qolindi: ${mode === 'all' ? 'Barcha akkauntlar' : 'Faqat asosiy'}` });
            
            const { getGroupPickerKeyboard, REYD_CHAT_REQUEST_ID } = require('../utils/helpers');
            global.userStates[chatId] = { step: 'WAITING_REYD_TARGET' };
            bot.sendMessage(chatId, "⚔️ Reyd qilinadigan guruh linki yoki usernameni yuboring:", {
                reply_markup: getGroupPickerKeyboard(REYD_CHAT_REQUEST_ID)
            });
            try { await bot.deleteMessage(chatId, messageId); } catch(e) {}
            return;
        }

        if (data === "reyd_add_acc") {
            const accCount = user.reydAccounts ? user.reydAccounts.length : 0;
            
            if (accCount >= 10) {
                return await safeAnswer({ text: "❌ Maksimal 10 ta akkaunt ulash mumkin.", show_alert: true });
            }

            const { getPhoneShareKeyboard } = require('../utils/helpers');
            global.userStates[chatId] = { step: 'WAITING_PHONE', isAdditional: true, isReyd: true };
            bot.sendMessage(chatId, "📞 Yangi akkaunt uchun **telefon raqamini** yuboring:\n", {
                parse_mode: "Markdown",
                reply_markup: getPhoneShareKeyboard()
            });
            return await safeAnswer();
        }

        if (data === "reyd_clear_acc") {
            await User.update({ reydAccounts: [] }, { where: { chatId } });
            return await safeAnswer({ text: "🗑 Reyd akkauntlari tozalandi.", show_alert: true });
        }

        if (data === "reyd_start") {
            if (!user.reydAccountMode) {
                const text = "🛠 **Reyd rejimini tanlang:**\n\nSiz bir marta rejimni tanlasangiz, bot uni eslab qoladi. Keyinchalik uni sozlamalar orqali o'zgartirishingiz mumkin.";
                const buttons = [
                    [{ text: "👤 Faqat asosiy akkaunt", callback_data: "reyd_set_mode_main" }],
                    [{ text: "🌐 Barcha akkauntlar", callback_data: "reyd_set_mode_all" }],
                    [{ text: "🔙 Orqaga", callback_data: "menu_reyd" }]
                ];
                await safeEdit(chatId, messageId, text, {
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: buttons }
                });
                return await safeAnswer();
            }
            const { getGroupPickerKeyboard, REYD_CHAT_REQUEST_ID } = require('../utils/helpers');
            global.userStates[chatId] = { step: 'WAITING_REYD_TARGET' };
            bot.sendMessage(chatId, "⚔️ Reyd qilinadigan guruh linki yoki usernameni yuboring:", {
                reply_markup: getGroupPickerKeyboard(REYD_CHAT_REQUEST_ID)
            });
            return await safeAnswer();
        }

        // ============ AVTO BAN ============
        if (data === "ban_menu") {
            const { getGroupPickerKeyboard, BAN_CHAT_REQUEST_ID } = require('../utils/helpers');
            global.userStates[chatId] = { step: 'WAITING_BAN_GROUP' };
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            await bot.sendMessage(
                chatId,
                "🚫 **Avto Ban**\n\nQaysi guruh/kanaldan banlamoqchisiz?\nGuruh linkini yuboring yoki pastdan tanlang:",
                { parse_mode: "Markdown", reply_markup: getGroupPickerKeyboard(BAN_CHAT_REQUEST_ID) }
            );
            return await safeAnswer();
        }

        if (data === "ban_filter_all" || data === "ban_filter_online" || data === "ban_filter_count") {
            const state = global.userStates[chatId];
            if (!state || state.step !== 'WAITING_BAN_FILTER') {
                return await safeAnswer({ text: "Sessiya muddati tugagan. Qaytadan boshlang.", show_alert: true });
            }

            if (data === "ban_filter_count") {
                global.userStates[chatId] = { ...state, step: 'WAITING_BAN_COUNT', filter: 'all' };
                await safeEdit(chatId, messageId, "🔢 Nechta odamni banlamoqchisiz? (faqat raqam yuboring, masalan: 50)", {
                    parse_mode: "Markdown"
                });
                return await safeAnswer();
            }

            const filter = data === "ban_filter_online" ? 'online' : 'all';
            global.userStates[chatId] = { ...state, step: 'WAITING_BAN_SPEED', filter, limit: 0 };
            const { getBanSpeedKeyboard } = require('../utils/helpers');
            await safeEdit(chatId, messageId, "⚙️ **Tezlikni tanlang:**\n\n🐢 Sekin — eng xavfsiz\n⚡ O'rtacha — muvozanat\n🚀 Tez — tezroq, lekin xavfli", {
                parse_mode: "Markdown",
                ...getBanSpeedKeyboard()
            });
            return await safeAnswer();
        }

        if (data === "ban_speed_slow" || data === "ban_speed_normal" || data === "ban_speed_fast") {
            const state = global.userStates[chatId];
            if (!state || state.step !== 'WAITING_BAN_SPEED') {
                return await safeAnswer({ text: "Sessiya muddati tugagan. Qaytadan boshlang.", show_alert: true });
            }
            const speed = data.replace('ban_speed_', '');
            await safeAnswer({ text: "⏳ Tekshirilmoqda..." });

            const { prepareBan } = require('../services/userbot');
            try {
                const info = await prepareBan(chatId, state.groupLink, state.filter, state.limit || 0, bot);
                global.userStates[chatId] = { ...state, step: 'CONFIRM_BAN', speed, groupTitle: info.title };

                const filterText = state.filter === 'online' ? 'Onlinelarni'
                    : (state.limit > 0 ? `${state.limit} ta odamni` : 'Hammani');
                const typeText = info.isChannel ? "🚫 Ban (superguruh/kanal)" : "👢 Chiqarish (oddiy guruh)";

                const confirmText =
                    `🚫 **Avto Ban — Tasdiqlash**\n\n` +
                    `📍 Guruh: ${info.title}\n` +
                    `🎯 Nishon: ${filterText}\n` +
                    `👥 Topildi: ${info.total} ta a'zo\n` +
                    `🔧 Amal: ${typeText}\n\n` +
                    `⚠️ **OGOHLANTIRISH:** Qilingan ishlar oqibatiga admin javob bermaydi. Barcha mas'uliyat foydalanuvchining zimmasida.\n\n` +
                    `Boshlash uchun tugmani bosing:`;

                await safeEdit(chatId, messageId, confirmText, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "✅ Boshlash", callback_data: "ban_start_confirm" }],
                            [{ text: "❌ Bekor qilish", callback_data: "ban_cancel" }]
                        ]
                    }
                });
            } catch (e) {
                global.userStates[chatId] = null;
                delete global.userStates[chatId];
                await safeEdit(chatId, messageId, `❌ **Banlab bo'lmaydi:**\n\n${e.message}`, {
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: "menu_reyd" }]] }
                });
            }
            return;
        }

        if (data === "ban_start_confirm") {
            const state = global.userStates[chatId];
            if (!state || state.step !== 'CONFIRM_BAN') {
                return await safeAnswer({ text: "Sessiya muddati tugagan.", show_alert: true });
            }
            await safeAnswer({ text: "🚫 Avto Ban boshlandi!" });
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}

            const { startBan } = require('../services/userbot');
            startBan(chatId, state.groupLink, state.filter, state.limit || 0, state.speed, bot).catch(err => {
                console.error("Ban error:", err.message);
                bot.sendMessage(chatId, "❌ Ban xatosi: " + err.message);
            });
            delete global.userStates[chatId];
            return;
        }

        if (data === "ban_cancel") {
            delete global.userStates[chatId];
            await safeAnswer({ text: "Bekor qilindi" });
            return await safeEdit(chatId, messageId, "❌ Avto Ban bekor qilindi.", {
                reply_markup: { inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: "menu_reyd" }]] }
            });
        }

        if (data === "ban_pause" || data === "ban_resume" || data === "ban_stop") {
            const { banSessions } = require('../services/userbot');
            if (!banSessions[chatId]) {
                return await safeAnswer({ text: "❌ Faol Ban jarayoni topilmadi.", show_alert: true });
            }
            const action = data.replace('ban_', '');
            if (action === "pause") {
                banSessions[chatId].status = 'paused';
                return await safeAnswer({ text: "⏸ Pauza" });
            }
            if (action === "resume") {
                banSessions[chatId].status = 'running';
                return await safeAnswer({ text: "▶️ Davom etmoqda" });
            }
            if (action === "stop") {
                banSessions[chatId].status = 'stopped';
                return await safeAnswer({ text: "⏹ To'xtatildi" });
            }
            return;
        }
        // ============ AVTO BAN END ============

        if (data === "menu_reklama") {
            const { getReklamaMenu } = require('../utils/helpers');
            const mode = user.reklamaAccountMode || 'main';
            const accCount = user.reklamaAccounts ? user.reklamaAccounts.length : 0;
            const modeText = mode === 'all' ? "Barcha akkauntlar" : "Faqat asosiy akkaunt";
            const text = `🚀 **Reklama bo'limi**\n\n⚙️ Hozirgi rejim: **${modeText}**\n👥 Akkauntlar: **${accCount + 1} ta**\n\nSiz bir nechta akkaunt ulab, reklamani yanada ko'proq odamga yuborishingiz mumkin. Akkaunt spamga tushsa, bot avtomatik keyingisiga o'tadi.`;
            
            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                ...getReklamaMenu(mode, accCount)
            });
            return await safeAnswer();
        }

        if (data === "reklama_change_mode") {
            const currentMode = user.reklamaAccountMode || 'main';
            const newMode = currentMode === 'all' ? 'main' : 'all';
            await User.update({ reklamaAccountMode: newMode }, { where: { chatId } });
            
            const { getReklamaMenu } = require('../utils/helpers');
            const accCount = user.reklamaAccounts ? user.reklamaAccounts.length : 0;
            const modeText = newMode === 'all' ? "Barcha akkauntlar" : "Faqat asosiy akkaunt";
            const text = `🚀 **Reklama bo'limi**\n\n⚙️ Hozirgi rejim: **${modeText}**\n👥 Akkauntlar: **${accCount + 1} ta**\n\nSiz bir nechta akkaunt ulab, reklamani yanada ko'proq odamga yuborishingiz mumkin. Akkaunt spamga tushsa, bot avtomatik keyingisiga o'tadi.`;
            
            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                ...getReklamaMenu(newMode, accCount)
            });
            return await safeAnswer({ text: `Rejim o'zgartirildi: ${modeText}` });
        }

        if (data.startsWith("reklama_set_mode_")) {
            const mode = data.replace('reklama_set_mode_', ''); // main or all
            await User.update({ reklamaAccountMode: mode }, { where: { chatId } });
            await safeAnswer({ text: `Rejim eslab qolindi: ${mode === 'all' ? 'Barcha akkauntlar' : 'Faqat asosiy'}` });
            
            global.userStates[chatId] = { step: 'WAITING_REK_USERS' };
            bot.sendMessage(chatId, "🚀 **Foydalanuvchilarning username ro'yxatini yuboring :**");
            try { await bot.deleteMessage(chatId, messageId); } catch(e) {}
            return;
        }

        if (data === "reklama_add_acc") {
            const accCount = user.reklamaAccounts ? user.reklamaAccounts.length : 0;
            
            if (accCount >= 10) {
                return await safeAnswer({ text: "❌ Maksimal 10 ta akkaunt ulash mumkin.", show_alert: true });
            }

            const { getPhoneShareKeyboard } = require('../utils/helpers');
            global.userStates[chatId] = { step: 'WAITING_PHONE', isAdditional: true, isReyd: false };
            bot.sendMessage(chatId, "📞 Yangi akkaunt uchun **telefon raqamini** yuboring:\n", {
                parse_mode: "Markdown",
                reply_markup: getPhoneShareKeyboard()
            });
            return await safeAnswer();
        }

        if (data === "reklama_clear_acc") {
            await User.update({ reklamaAccounts: [] }, { where: { chatId } });
            return await safeAnswer({ text: "🗑 Reklama akkauntlari tozalandi.", show_alert: true });
        }

        if (data === "reklama_start") {
            if (!user.reklamaAccountMode) {
                const text = "🛠 **Reklama rejimini tanlang:**\n\nSiz bir marta rejimni tanlasangiz, bot uni eslab qoladi. Keyinchalik uni sozlamalar orqali o'zgartirishingiz mumkin.";
                const buttons = [
                    [{ text: "👤 Faqat asosiy akkaunt", callback_data: "reklama_set_mode_main" }],
                    [{ text: "🌐 Barcha akkauntlar", callback_data: "reklama_set_mode_all" }],
                    [{ text: "🔙 Orqaga", callback_data: "menu_reklama" }]
                ];
                await safeEdit(chatId, messageId, text, {
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: buttons }
                });
                return await safeAnswer();
            }
            global.userStates[chatId] = { step: 'WAITING_REK_USERS' };
            bot.sendMessage(chatId, "🚀 **Foydalanuvchilarning username ro'yxatini yuboring :**");
            return await safeAnswer();
        }

        if (data === "reklama_start_confirm") {
            await safeAnswer({ text: "🚀 Reklama boshlandi!" });
            
            const state = global.userStates[chatId];
            if (!state || state.step !== 'CONFIRM_REK') {
                return;
            }

            const { startReklama } = require('../services/userbot');
            try {
                await bot.deleteMessage(chatId, messageId);
            } catch (e) {}
            
            // Async chaqiramiz
            startReklama(chatId, state.usersList, state.reklamaMsg, bot).catch(err => {
                console.error("Reklama error:", err.message);
                bot.sendMessage(chatId, "❌ Reklama boshlashda xatolik: " + err.message);
            });
            
            delete global.userStates[chatId];
            return;
        }

        if (data === "reklama_cancel") {
            await safeAnswer();
            delete global.userStates[chatId];
            return await safeEdit(chatId, messageId, "❌ Reklama bekor qilindi.", { reply_markup: { inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: "menu_reklama" }]] } });
        }

        if (data === "reklama_spam_continue") {
            const { reklamaStates } = require('../services/userbot');
            if (reklamaStates[chatId] && reklamaStates[chatId].resolveSpam) {
                reklamaStates[chatId].resolveSpam(true);
                delete reklamaStates[chatId].resolveSpam;
                await safeAnswer({ text: "▶️ Davom etilmoqda..." });
                try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            } else {
                await safeAnswer({ text: "❌ Jarayon topilmadi.", show_alert: true });
            }
            return;
        }

        if (data === "reklama_spam_stop") {
            const { reklamaStates } = require('../services/userbot');
            if (reklamaStates[chatId] && reklamaStates[chatId].resolveSpam) {
                reklamaStates[chatId].resolveSpam(false);
                delete reklamaStates[chatId].resolveSpam;
                await safeAnswer({ text: "⏹ To'xtatildi." });
                try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            } else {
                await safeAnswer({ text: "❌ Jarayon topilmadi.", show_alert: true });
            }
            return;
        }

        if (data.startsWith("reklama_")) {
            const { reklamaStates } = require('../services/userbot');
            if (!reklamaStates[chatId]) {
                return await safeAnswer({ text: "❌ Faol Reklama jarayoni topilmadi.", show_alert: true });
            }

            const action = data.split('_')[1];
            await safeAnswer({ text: action === "pause" ? "⏸ Pauza" : (action === "resume" ? "▶️ Davom etmoqda" : "⏹ To'xtatildi") });

            const getReklamaButtons = (status) => {
                const buttons = [];
                if (status === 'running') buttons.push({ text: "⏸ Pauza", callback_data: "reklama_pause" });
                if (status === 'paused') buttons.push({ text: "▶️ Davom etish", callback_data: "reklama_resume" });
                buttons.push({ text: "⏹ To'xtatish", callback_data: "reklama_stop" });
                return { reply_markup: { inline_keyboard: [buttons] } };
            };

            if (action === "pause") {
                reklamaStates[chatId].status = 'paused';
                return await safeEdit(chatId, messageId, `⏸ **Avto Reklama to'xtatib turilibdi...**\nProgress: ${reklamaStates[chatId].count}/${reklamaStates[chatId].total}`, getReklamaButtons('paused'));
            }
            if (action === "resume") {
                reklamaStates[chatId].status = 'running';
                return await safeEdit(chatId, messageId, `🚀 **Reklama jarayoni...**\nProgress: ${reklamaStates[chatId].count}/${reklamaStates[chatId].total}`, getReklamaButtons('running'));
            }
            if (action === "stop") {
                reklamaStates[chatId].status = 'stopped';
                return;
            }
            return;
        }

        if (data === "reyd_start_confirm") {
            await safeAnswer({ text: "🚀 Reyd boshlandi!" });
            
            const state = global.userStates[chatId];
            if (!state || state.step !== 'CONFIRM_REYD') {
                return; // Already answered or invalid state
            }

            const { startReyd } = require('../services/userbot');
            try {
                await bot.deleteMessage(chatId, messageId);
            } catch (e) {}
            
            // Async chaqiramiz, event loopni bloklamaslik uchun
            startReyd(chatId, state.target, state.reydMsg, state.limit, bot, state.stickerPath).catch(err => {
                console.error("Reyd error:", err.message);
                bot.sendMessage(chatId, "❌ Reyd boshlashda xatolik: " + err.message);
            });
            
            delete global.userStates[chatId];
            return;
        }

        if (data === "reyd_cancel") {
            await safeAnswer();
            delete global.userStates[chatId];
            return await safeEdit(chatId, messageId, "❌ Reyd bekor qilindi.", { reply_markup: { inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: "menu_reyd" }]] } });
        }

        if (data.startsWith("reyd_")) {
            const { reydSessions } = require('../services/userbot');
            if (!reydSessions[chatId]) {
                return await safeAnswer({ text: "❌ Faol Reyd jarayoni topilmadi.", show_alert: true });
            }

            const action = data.split('_')[1];
            await safeAnswer({ text: action === "pause" ? "⏸ Pauza" : (action === "resume" ? "▶️ Davom etmoqda" : "⏹ To'xtatildi") });

            const getReydButtons = (status) => {
                const buttons = [];
                if (status === 'running') buttons.push({ text: "⏸ Pauza", callback_data: "reyd_pause" });
                if (status === 'paused') buttons.push({ text: "▶️ Davom etish", callback_data: "reyd_resume" });
                buttons.push({ text: "⏹ To'xtatish", callback_data: "reyd_stop" });
                return { reply_markup: { inline_keyboard: [buttons] } };
            };

            if (action === "pause") {
                reydSessions[chatId].status = 'paused';
                return await safeEdit(chatId, messageId, `⏸ **Reyd to'xtatib turilibdi...**\nNishon: ${reydSessions[chatId].target || ""}\nProgress: ${reydSessions[chatId].count}/${reydSessions[chatId].total}`, getReydButtons('paused'));
            }
            if (action === "resume") {
                reydSessions[chatId].status = 'running';
                return await safeEdit(chatId, messageId, `🚀 **Reyd jarayoni...**\nNishon: ${reydSessions[chatId].target || ""}\nProgress: ${reydSessions[chatId].count}/${reydSessions[chatId].total}`, getReydButtons('running'));
            }
            if (action === "stop") {
                reydSessions[chatId].status = 'stopped';
                return;
            }
            return;
        }

        if (data === "menu_utag") {
            const { getUtagMenu } = require('../utils/helpers');
            const mode = user.utagAccountMode || 'main';
            const rekCount = (user.reklamaAccounts || []).length;
            const modeText = mode === 'all' ? "Barcha akkauntlar" : "Faqat asosiy akkaunt";
            const text = `🏷 **Utag Bo'limi :**\n\n⚙️ Hozirgi rejim: **${modeText}**\n👥 Akkauntlar: **${rekCount + 1} ta**\n\n🚀 **Yangi boshlash**\n➤ Yangi guruh tanlab, avtomatik tag jarayonini boshlang.\n\n📂 **Tarix**\n➤ Oldin ishlatilgan guruhlardan birini tanlab davom eting.`;
            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                ...getUtagMenu(mode, rekCount)
            });
            return await safeAnswer();
        }

        if (data === "utag_change_mode") {
            const currentMode = user.utagAccountMode || 'main';
            const newMode = currentMode === 'all' ? 'main' : 'all';
            await User.update({ utagAccountMode: newMode }, { where: { chatId } });
            
            const { getUtagMenu } = require('../utils/helpers');
            const rekCount = (user.reklamaAccounts || []).length;
            const modeText = newMode === 'all' ? "Barcha akkauntlar" : "Faqat asosiy akkaunt";
            const text = `🏷 **Utag Bo'limi :**\n\n⚙️ Hozirgi rejim: **${modeText}**\n👥 Akkauntlar: **${rekCount + 1} ta**\n\n🚀 **Yangi boshlash**\n➤ Yangi guruh tanlab, avtomatik tag jarayonini boshlang.\n\n📂 **Tarix**\n➤ Oldin ishlatilgan guruhlardan birini tanlab davom eting.`;
            
            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                ...getUtagMenu(newMode, rekCount)
            });
            return await safeAnswer({ text: `Rejim o'zgartirildi: ${modeText}` });
        }

        if (data === "utag_start_new") {
            if (!user.utagAccountMode) {
                const text = "🛠 **Utag rejimini tanlang:**\n\nSiz bir marta rejimni tanlasangiz, bot uni eslab qoladi. Keyinchalik uni sozlamalar orqali o'zgartirishingiz mumkin.";
                const buttons = [
                    [{ text: "👤 Faqat asosiy akkaunt", callback_data: "utag_set_mode_main" }],
                    [{ text: "🌐 Barcha akkauntlar", callback_data: "utag_set_mode_all" }],
                    [{ text: "🔙 Orqaga", callback_data: "menu_utag" }]
                ];
                await safeEdit(chatId, messageId, text, {
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: buttons }
                });
                return await safeAnswer();
            }
            const { getGroupPickerKeyboard, UTAG_CHAT_REQUEST_ID } = require('../utils/helpers');
            global.userStates[chatId] = { step: 'WAITING_UTAG_LINK' };
            bot.sendMessage(chatId, "🔗 Qaysi guruhda tag qilmoqchisiz? Gurux linkini yuboring yoki tanlang:", {
                reply_markup: getGroupPickerKeyboard(UTAG_CHAT_REQUEST_ID)
            });
            return await safeAnswer();
        }

        if (data.startsWith("utag_set_mode_")) {
            const mode = data.replace('utag_set_mode_', ''); // main or all
            await User.update({ utagAccountMode: mode }, { where: { chatId } });
            await safeAnswer({ text: `Rejim eslab qolindi: ${mode === 'all' ? 'Barcha akkauntlar' : 'Faqat asosiy'}` });
            
            const { getGroupPickerKeyboard, UTAG_CHAT_REQUEST_ID } = require('../utils/helpers');
            global.userStates[chatId] = { step: 'WAITING_UTAG_LINK' };
            bot.sendMessage(chatId, "🔗 Qaysi guruhda tag qilmoqchisiz? Gurux linkini yuboring yoki tanlang:", {
                reply_markup: getGroupPickerKeyboard(UTAG_CHAT_REQUEST_ID)
            });
            try { await bot.deleteMessage(chatId, messageId); } catch(e) {}
            return;
        }

        if (data === 'utag_filter_online' || data === 'utag_filter_all') {
            const state = global.userStates[chatId];
            if (!state || state.step !== 'WAITING_UTAG_SETUP') {
                return await safeAnswer({ text: "Sessiya muddati tugagan.", show_alert: true });
            }
            state.memberFilter = data === 'utag_filter_online' ? 'online' : 'all';
            state.limit = 0;
            state.step = 'WAITING_UTAG_MODE';
            global.userStates[chatId] = state;
            await safeAnswer();
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            const { getUtagModeKeyboard } = require('../utils/helpers');
            return bot.sendMessage(chatId, "🛠 **Tag rejimini tanlang:**", {
                parse_mode: 'Markdown',
                ...getUtagModeKeyboard()
            });
        }

        if (data.startsWith("utag_mode_")) {
            const mode = data.replace('utag_mode_', '');
            const state = global.userStates[chatId];
            if (!state || state.step !== 'WAITING_UTAG_MODE') {
                return await safeAnswer({ text: "Sessiya muddati tugagan.", show_alert: true });
            }
            state.mode = mode;

            if (mode === 'only_mention' || mode === 'random_words') {
                delete global.userStates[chatId];
                await safeAnswer({ text: "🚀 Utag boshlanmoqda..." });
                try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
                const { startAutoTag } = require('../services/userbot');
                startAutoTag(chatId, state.groupLink, bot, {
                    limit: state.limit ?? 0,
                    mode,
                    memberFilter: state.memberFilter || 'all',
                    groupTitle: state.groupTitle,
                    tagText: null
                }).catch((err) => bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`));
            } else {
                state.step = 'WAITING_UTAG_CUSTOM_TEXT';
                global.userStates[chatId] = state;
                await safeAnswer();
                try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
                bot.sendMessage(chatId, "✍️ Tag qilinganda foydalanuvchi ismi yonidan chiqadigan **matnni** yuboring:", { parse_mode: 'Markdown' });
            }
            return;
        }

        if (data === 'utag_clear_history') {
            await User.update({ utagHistory: [] }, { where: { chatId } });
            await safeAnswer({ text: "📂 Tarix tozalandi." });
            const { getUtagMenu } = require('../utils/helpers');
            const mode = user.utagAccountMode || 'main';
            const rekCount = (user.reklamaAccounts || []).length;
            const modeText = mode === 'all' ? "Barcha akkauntlar" : "Faqat asosiy akkaunt";
            const text = `🏷 **Utag Bo'limi :**\n\n⚙️ Hozirgi rejim: **${modeText}**\n👥 Akkauntlar: **${rekCount + 1} ta**\n\n🚀 **Yangi boshlash**\n➤ Yangi guruh tanlab, avtomatik tag jarayonini boshlang.\n\n📂 **Tarix**\n➤ Oldin ishlatilgan guruhlardan birini tanlab davom eting.`;
            return safeEdit(chatId, messageId, text, { parse_mode: 'Markdown', ...getUtagMenu(mode, rekCount) });
        }

        if (data === "utag_history") {
            if (!user.utagHistory || user.utagHistory.length === 0) {
                return await safeAnswer({ text: "📜 Tarix hali bo'sh.", show_alert: true });
            }

            let text = "📜 **Utag Tarixi:**\n\nQayta ishlatish uchun guruhni tanlang:\n";
            const buttons = [];
            user.utagHistory.forEach((h, index) => {
                buttons.push([{ text: `📍 ${h.title}`, callback_data: `utag_re_${index}` }]);
            });
            buttons.push([{ text: "🔙 Orqaga", callback_data: "menu_utag" }]);

            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: buttons }
            });
            return await safeAnswer();
        }

        if (data.startsWith("utag_re_")) {
            const index = parseInt(data.split('_')[2], 10);
            const group = user.utagHistory[index];
            if (!group) return await safeAnswer({ text: "❌ Ma'lumot topilmadi.", show_alert: true });

            const groupLink = group.link || group.id;
            const saved = {
                groupLink,
                groupTitle: group.title,
                limit: group.limit ?? 0,
                memberFilter: group.memberFilter || 'all',
                mode: group.mode || 'only_mention',
                tagText: group.tagText || null
            };

            if (saved.mode === 'custom' && !saved.tagText) {
                global.userStates[chatId] = { step: 'WAITING_UTAG_CUSTOM_TEXT', ...saved };
                await safeAnswer();
                return bot.sendMessage(chatId, `📍 **${group.title}**\n\n✍️ Tag matnini yuboring:`, { parse_mode: 'Markdown' });
            }

            await safeAnswer({ text: "🚀 Saqlangan sozlamalar bilan boshlanmoqda..." });
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            const { startAutoTag } = require('../services/userbot');
            startAutoTag(chatId, groupLink, bot, {
                limit: saved.limit,
                mode: saved.mode,
                tagText: saved.tagText,
                memberFilter: saved.memberFilter,
                groupTitle: saved.groupTitle
            }).catch((err) => bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`));
            return;
        }

        if (["utag_pause", "utag_resume", "utag_stop"].includes(data)) {
            const { utagStates } = require('../services/userbot');
            if (!utagStates[chatId]) {
                return await safeAnswer({ text: "❌ Faol UTag jarayoni topilmadi.", show_alert: true });
            }

            const action = data.split('_')[1];
            await safeAnswer({ text: action === "pause" ? "⏸ Pauza" : (action === "resume" ? "▶️ Davom etmoqda" : "⏹ To'xtatildi") });

            const getUtagButtons = (status) => {
                const buttons = [];
                if (status === 'running') buttons.push({ text: "⏸ Pauza", callback_data: "utag_pause" });
                if (status === 'paused') buttons.push({ text: "▶️ Davom etish", callback_data: "utag_resume" });
                buttons.push({ text: "⏹ To'xtatish", callback_data: "utag_stop" });
                return { reply_markup: { inline_keyboard: [buttons] } };
            };

            if (action === "pause") {
                utagStates[chatId].status = 'paused';
                return await safeEdit(chatId, messageId, `⏸ **Utag to'xtatib turilibdi...**\nProgress: ${utagStates[chatId].count}/${utagStates[chatId].total}`, getUtagButtons('paused'));
            }
            if (action === "resume") {
                utagStates[chatId].status = 'running';
                return await safeEdit(chatId, messageId, `🚀 **Utag jarayoni...**\nProgress: ${utagStates[chatId].count}/${utagStates[chatId].total}`, getUtagButtons('running'));
            }
            if (action === "stop") {
                utagStates[chatId].status = 'stopped';
                return;
            }
            return;
        }

        if (data === "menu_logout") {
            await safeAnswer();
            return bot.sendMessage(
                chatId,
                "⚠️ **Raqamni o'zgartirish**\n\nJoriy akkauntdan chiqasiz. Tasdiqlaysizmi?",
                {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "✅ Tasdiqlash", callback_data: "logout_confirm" }],
                            [{ text: "❌ Bekor qilish", callback_data: "logout_cancel" }]
                        ]
                    }
                }
            );
        }

        if (data === "logout_cancel") {
            await safeAnswer({ text: "Bekor qilindi" });
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            return bot.sendMessage(chatId, "📋 **Asosiy menyu:**", { parse_mode: "Markdown", ...getMainMenu(chatId) });
        }

        if (data === "logout_confirm") {
            await User.update({ session: null }, { where: { chatId } });
            triggerBackup('logout', true);
            const { userClients } = require('../services/userbot');
            if (userClients[chatId]) {
                try { await userClients[chatId].disconnect(); } catch (e) {}
                delete userClients[chatId];
            }
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            await safeAnswer({ text: "Hisobdan chiqildi" });
            return bot.sendMessage(chatId, "🔄 Hisobdan chiqildi. Qayta kirish uchun /start bosing.");
        }

        if (data === "menu_profile") {
            const { formatRemainingTime } = require('../utils/helpers');
            
            const statusText = user.status === 'approved' ? "✅ Tasdiqlangan" : "⏳ Tasdiqlanmagan";
            const tarifText = user.subscriptionType || "Oddiy";
            let remainingTime = formatRemainingTime(user.expireAt);
            if (remainingTime.includes("Cheksiz")) remainingTime = "Cheksiz";
            
            const rekAccCount = user.reklamaAccounts ? user.reklamaAccounts.length : 0;
            const reydAccCount = user.reydAccounts ? user.reydAccounts.length : 0;
            
            const joinedDate = user.joinedAt ? new Date(user.joinedAt) : new Date();
            const regDate = `${joinedDate.getDate()}/${joinedDate.getMonth() + 1}/${joinedDate.getFullYear()}`;
            
            const text = `👤 **Sizning Profilingiz:**\n\n` +
                `📛 **Ism:** ${user.name || "Noma'lum"}\n` +
                `🆔 **ID:** \`${user.chatId}\`\n` +
                `🔰 **Holat:** ${statusText}\n` +
                `⏰ **Tarif:** ${tarifText}\n` +
                `⏳ **Qolgan vaqt:** ${remainingTime}\n\n` +
                `🗂 **Ulangan akkauntlar soni:**\n` +
                `📣 Rek: ${rekAccCount} ta  , ⚔️ Reyd ${reydAccCount} ta\n\n` +
                `⚔️ **Reydlar soni:** ${user.reydCount || 0} ta\n` +
                `👥 **Yig'ilgan userlar:** ${user.usersGathered || 0} ta\n` +
                `📢 **Yuborilgan reklamalar:** ${user.adsCount || 0} ta\n` +
                `🏷 **Utag jarayonlari:** ${user.utagCount || 0} ta\n` +
                `🏷 **To'plangan almazlar:** ${user.clicks || 0} ta\n\n` +
                `📅 **Ro'yxatdan o'tgan sana:** ${regDate}`;

            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: "menu_back_main" }]]
                }
            });
            return await safeAnswer();
        }

        // --- 3. ADMIN PANEL ---
        if (data === "admin_panel") { 
            if (chatId.toString() !== config.adminId.toString()) return;
            await safeEdit(chatId, messageId, "👨‍💻 Admin Panel:", { ...getAdminMenu() }); 
            return await safeAnswer();
        } 

        if (data === "admin_stats") {
            const total = await User.count();
            const approved = await User.count({ where: { status: 'approved' } });
            const pending = await User.count({ where: { status: 'pending' } });
            const blocked = await User.count({ where: { status: 'blocked' } });

            const stats = await User.findAll({
                attributes: [
                    [sequelize.fn('SUM', sequelize.col('clicks')), 'totalClicks'],
                    [sequelize.fn('SUM', sequelize.col('utagCount')), 'totalUtag'],
                    [sequelize.fn('SUM', sequelize.col('reydCount')), 'totalReyd'],
                    [sequelize.fn('SUM', sequelize.col('usersGathered')), 'totalGathered'],
                    [sequelize.fn('SUM', sequelize.col('adsCount')), 'totalAds']
                ],
                raw: true
            });

            const s = stats[0] || { totalClicks: 0, totalUtag: 0, totalReyd: 0, totalGathered: 0, totalAds: 0 };

            const statsText = `📊 **Bot Statistikasi:** \n\n` +
                `👥 **Jami foydalanuvchilar:** ${total} \n` +
                `✅ **Tasdiqlanganlar:** ${approved} \n` +
                `⏳ **Kutilayotganlar:** ${pending} \n` +
                `🚫 **Bloklanganlar:** ${blocked} \n\n` +
                `💎 **Jami almazlar:** ${s.totalClicks || 0} ta \n` +
                `🏷 **Jami utaglar:** ${s.totalUtag || 0} ta \n` +
                `⚔️ **Jami reydlar:** ${s.totalReyd || 0} ta \n` +
                `👥 **Jami yig'ilgan userlar:** ${s.totalGathered || 0} ta \n` +
                `📢 **Jami yuborilgan reklamalar:** ${s.totalAds || 0} ta`;

            await safeEdit(chatId, messageId, statsText, {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: "admin_panel" }]] }
            });
            return await safeAnswer();
        }

        if (data.startsWith("admin_info_")) {
            const targetId = data.replace("admin_info_", "");
            const user = await User.findOne({ where: { chatId: targetId } });
            if (!user) {
                return await safeAnswer({ text: "❌ Foydalanuvchi topilmadi.", show_alert: true });
            }
            
            const { formatRemainingTime } = require('../utils/helpers');
            
            const statusText = user.status === 'approved' ? "✅ Tasdiqlangan" : (user.status === 'blocked' ? "🚫 Bloklangan" : "⏳ Tasdiqlanmagan");
            const tarifText = user.subscriptionType || "Oddiy";
            let remainingTime = formatRemainingTime(user.expireAt);
            if (remainingTime.includes("Cheksiz")) remainingTime = "Cheksiz";

            const rekAccCount = user.reklamaAccounts ? user.reklamaAccounts.length : 0;
            const reydAccCount = user.reydAccounts ? user.reydAccounts.length : 0;
            
            const joinedDate = user.joinedAt ? new Date(user.joinedAt) : new Date();
            const regDate = `${joinedDate.getFullYear()}-${String(joinedDate.getMonth() + 1).padStart(2, '0')}-${String(joinedDate.getDate()).padStart(2, '0')} ${String(joinedDate.getHours()).padStart(2, '0')}:${String(joinedDate.getMinutes()).padStart(2, '0')}`;

            const text = `👤 **Foydalanuvchi Ma'lumotlari:**\n\n` +
                `📛 **Ism:** ${user.name || "Noma'lum"}\n` +
                `🔗 **Username:** ${user.username ? `@${user.username}` : "Yo'q"}\n` +
                `🆔 **ID:** \`${user.chatId}\`\n` +
                `🔰 **Holat:** ${statusText}\n` +
                `⏰ **Tarif:** ${tarifText}\n` +
                `⏳ **Qolgan vaqt:** ${remainingTime}\n\n` +
                `🗂 **Ulangan akkauntlar soni:**\n` +
                `📣 Reklama: ${rekAccCount} ta | ⚔️ Reyd: ${reydAccCount} ta\n\n` +
                `📊 **Statistika:**\n` +
                `⚔️ Reydlar: ${user.reydCount || 0} ta\n` +
                `👥 Yig'ilgan userlar: ${user.usersGathered || 0} ta\n` +
                `📢 Yuborilgan reklamalar: ${user.adsCount || 0} ta\n` +
                `🏷 Utaglar: ${user.utagCount || 0} ta\n` +
                `💎 Almazlar: ${user.clicks || 0} ta\n\n` +
                `📅 **Ro'yxatdan o'tgan:** ${regDate}`;

            await safeEdit(chatId, messageId, text, { 
                parse_mode: "Markdown",
                reply_markup: { 
                    inline_keyboard: [
                        [{ text: "✅ 1 Oy", callback_data: `admin_approve_1month_${targetId}` }],
                        [{ text: "👑 VIP", callback_data: `admin_approve_vip_${targetId}` }],
                        [{ text: "✍️ Ixtiyoriy", callback_data: `admin_approve_${targetId}` }],
                        [{ text: "🚫 Bloklash", callback_data: `admin_block_${targetId}` }],
                        [{ text: "🔙 Orqaga", callback_data: "admin_panel" }]
                    ] 
                } 
            });
            return await safeAnswer();
        }
        
        if (data === "admin_all_users" || data.startsWith("admin_all_users_page_")) {
            const page = data.startsWith("admin_all_users_page_")
                ? parseInt(data.replace("admin_all_users_page_", ""), 10) || 0
                : 0;
            const users = await User.findAll({ order: [['joinedAt', 'DESC']] });
            const { text, reply_markup } = buildUserListPage(users, page, "Barcha A'zolar", "admin_all_users");

            await safeEdit(chatId, messageId, text, {
                skipEmojiWrap: true,
                reply_markup
            });
            return await safeAnswer();
        }

        if (
            data === "admin_pending" || data === "admin_approved" || data === "admin_blocked" ||
            data.startsWith("admin_pending_page_") || data.startsWith("admin_approved_page_") || data.startsWith("admin_blocked_page_")
        ) {
            const baseMatch = data.match(/^(admin_pending|admin_approved|admin_blocked)/);
            const base = baseMatch[1];
            const page = data.includes("_page_")
                ? parseInt(data.split("_page_")[1], 10) || 0
                : 0;

            const statusMap = {
                "admin_pending": "pending",
                "admin_approved": "approved",
                "admin_blocked": "blocked"
            };
            const status = statusMap[base];
            const statusTextMap = {
                "pending": "Kutilayotganlar",
                "approved": "Tasdiqlanganlar",
                "blocked": "Bloklanganlar"
            };

            const users = await User.findAll({ where: { status }, order: [['joinedAt', 'DESC']] });
            const { text, reply_markup } = buildUserListPage(users, page, statusTextMap[status], base);

            await safeEdit(chatId, messageId, text, {
                skipEmojiWrap: true,
                reply_markup
            });
            return await safeAnswer();
        }

        if (data === "admin_broadcast") {
            global.userStates[chatId] = { step: 'WAITING_BROADCAST' };
            await safeAnswer();
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            return bot.sendMessage(chatId, "📢 Barchaga yuboriladigan xabarni yuboring (matn, rasm, video va h.k.):", {
                reply_markup: {
                    inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: "admin_panel" }]]
                }
            });
        }

        if (data === "admin_channels") {
            const channels = await Channel.findAll();
            let channelList = "📢 **Kanal sozlamalari:**\n\n";
            
            if (channels.length === 0) {
                channelList += "Hozircha hech qanday kanal qo'shilmagan";
            } else {
                for (const ch of channels) {
                    channelList += `• ${ch.name} - ${ch.url}\n`;
                }
            }
            
            const buttons = [
                [{ text: "➕ Kanal qo'shish", callback_data: "admin_add_channel" }],
                [{ text: "🔙 Orqaga", callback_data: "admin_panel" }]
            ];

            await safeEdit(chatId, messageId, channelList, {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: buttons }
            });
            return await safeAnswer();
        }

        if (data === "admin_add_channel") {
            global.userStates[chatId] = { step: 'WAITING_CHANNEL_ID' };
            await safeAnswer();
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            return bot.sendMessage(chatId, "📢 Kanal ID sini yuboring (masalan: -1001234567890):", {
                reply_markup: {
                    inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: "admin_channels" }]]
                }
            });
        }

        if (data.startsWith("admin_approve_1month_")) {
            const targetId = data.replace("admin_approve_1month_", "");
            const now = new Date();
            const expireAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
            await User.update({ status: 'approved', expireAt, subscriptionType: 'monthly', expiryWarningSent: false }, { where: { chatId: targetId } });
            triggerBackup('admin_approve', true);
            await bot.sendMessage(targetId, "🎉 Tabriklaymiz! Sizning akkauntingiz 1 oylik uchun tasdiqlandi! /start ni bosing.");
            await safeAnswer({ text: "✅ Foydalanuvchi 1 oylik uchun tasdiqlandi!", show_alert: true });

            const target = await User.findOne({ where: { chatId: targetId } });
            const expStr = `${expireAt.getFullYear()}-${String(expireAt.getMonth() + 1).padStart(2, '0')}-${String(expireAt.getDate()).padStart(2, '0')}`;
            const resultText = `✅ **Tasdiqlandi (1 Oy)**\n\n` +
                `📛 **Ism:** ${target?.name || "Noma'lum"}\n` +
                `🔗 **Username:** ${target?.username ? `@${target.username}` : "Yo'q"}\n` +
                `🆔 **ID:** \`${targetId}\`\n` +
                `⏰ **Tarif:** 1 Oy\n` +
                `📅 **Tugash sanasi:** ${expStr}\n\n` +
                `👨‍💻 Admin: ${query.from.first_name || ''}`;
            await safeEdit(chatId, messageId, resultText, { parse_mode: "Markdown" });
            return;
        }

        if (data.startsWith("admin_approve_vip_")) {
            const targetId = data.replace("admin_approve_vip_", "");
            await User.update({ status: 'approved', expireAt: null, subscriptionType: 'VIP', expiryWarningSent: false }, { where: { chatId: targetId } });
            triggerBackup('admin_approve', true);
            await bot.sendMessage(targetId, "🎉 Tabriklaymiz! Sizning akkauntingiz VIP sifatida tasdiqlandi! /start ni bosing.");
            await safeAnswer({ text: "✅ Foydalanuvchi VIP sifatida tasdiqlandi!", show_alert: true });

            const target = await User.findOne({ where: { chatId: targetId } });
            const resultText = `👑 **Tasdiqlandi (VIP)**\n\n` +
                `📛 **Ism:** ${target?.name || "Noma'lum"}\n` +
                `🔗 **Username:** ${target?.username ? `@${target.username}` : "Yo'q"}\n` +
                `🆔 **ID:** \`${targetId}\`\n` +
                `⏰ **Tarif:** VIP (cheksiz)\n\n` +
                `👨‍💻 Admin: ${query.from.first_name || ''}`;
            await safeEdit(chatId, messageId, resultText, { parse_mode: "Markdown" });
            return;
        }

        if (data.startsWith("admin_approve_") && !data.includes("1month") && !data.includes("vip")) {
            const targetId = data.replace("admin_approve_", "");
            global.userStates[chatId] = { step: 'WAITING_TIME', targetId };
            await safeAnswer();
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            return bot.sendMessage(chatId, "⏳ Muddatni kiriting (masalan: 1 oy, 2 kun, 1 soat):", {
                reply_markup: {
                    inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: "admin_panel" }]]
                }
            });
        }

        if (data.startsWith("admin_block_")) {
            const targetId = data.replace("admin_block_", "");
            await User.update({ status: 'blocked' }, { where: { chatId: targetId } });
            triggerBackup('admin_block', true);
            await bot.sendMessage(targetId, "⚠️ Sizning akkauntingiz bloklandi. Admin bilan bog'laning.");
            await safeAnswer({ text: "🚫 Foydalanuvchi bloklandi!", show_alert: true });

            const target = await User.findOne({ where: { chatId: targetId } });
            const resultText = `🚫 **Bloklandi**\n\n` +
                `📛 **Ism:** ${target?.name || "Noma'lum"}\n` +
                `🔗 **Username:** ${target?.username ? `@${target.username}` : "Yo'q"}\n` +
                `🆔 **ID:** \`${targetId}\`\n\n` +
                `👨‍💻 Admin: ${query.from.first_name || ''}`;
            await safeEdit(chatId, messageId, resultText, { parse_mode: "Markdown" });
            return;
        }
    });
};

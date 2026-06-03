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
    getBonusCoinRow,
    getPendingPaymentKeyboard
} = require('../utils/helpers');
const {
    isBonusEnabled,
    setBonusEnabled,
    buildBonusMessage,
    buildCoinMessage,
    redeemCoinsForMonth,
    refreshReferralToken,
    processSubscriptionReferralReward,
    getAdminBonusStats,
    getTop10Referrers,
    getCoinRedeemers,
    adminSetCoins,
    COINS_PER_MONTH
} = require('../services/bonus');

if (!global.userStates) global.userStates = {};

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

        // --- 1. SESSION CHECK (Except for specific ones) ---
        const user = await findUserByChatId(chatId);
        const allowedCallbacks = [
            "check_subscription",
            "menu_bonus",
            "menu_coin",
            "bonus_new_link",
            "coin_redeem_month",
            "menu_back_main",
            "auth_resend_sms",
            "auth_resend_app"
        ];
        const isAdminAction = data.startsWith("admin_");
        const isBonusCallback = data.startsWith("bonus_") || data.startsWith("coin_") || data === "menu_bonus" || data === "menu_coin";
        
        if (!isAdminAction && !allowedCallbacks.includes(data) && !isBonusCallback) {
            if (!user || !user.session) {
                await safeAnswer({ 
                    text: "⚠️ Botdan foydalanish uchun avval Telegram akkauntingiz bilan tizimga kiring. /start ni bosing.", 
                    show_alert: true 
                });
                return;
            }
        }

        if (data === "auth_resend_sms" || data === "auth_resend_app") {
            const { resendAuthCode } = require('../services/userbot');
            try {
                await resendAuthCode(chatId, bot, data === "auth_resend_sms");
                return await safeAnswer({
                    text: data === "auth_resend_sms" ? "SMS yuborildi" : "Kod qayta yuborildi"
                });
            } catch (e) {
                return await safeAnswer({ text: e.message, show_alert: true });
            }
        }

        // --- BONUS / COIN (session va obuna shartsiz) ---
        if (data === "menu_bonus") {
            if (!user) {
                await User.create({
                    chatId,
                    name: query.from.first_name,
                    username: query.from.username,
                    status: chatId.toString() === config.adminId.toString() ? 'approved' : 'pending'
                });
            }
            const { text, keyboard, parseMode } = await buildBonusMessage(bot, chatId);
            const bonusOpts = { parse_mode: parseMode || 'HTML', reply_markup: keyboard, skipEmojiWrap: true };
            try {
                await safeEdit(chatId, messageId, text, bonusOpts);
            } catch (e) {
                await bot.sendMessage(chatId, text, bonusOpts);
            }
            return await safeAnswer();
        }

        if (data === "menu_coin") {
            if (!user) {
                await User.create({
                    chatId,
                    name: query.from.first_name,
                    username: query.from.username,
                    status: chatId.toString() === config.adminId.toString() ? 'approved' : 'pending'
                });
            }
            const { text, keyboard } = await buildCoinMessage(chatId);
            try {
                await safeEdit(chatId, messageId, text, { parse_mode: "Markdown", reply_markup: keyboard });
            } catch (e) {
                await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
            }
            return await safeAnswer();
        }

        if (data === "bonus_new_link") {
            if (!(await isBonusEnabled())) {
                return await safeAnswer({ text: "Bonus tizimi o'chirilgan", show_alert: true });
            }
            await refreshReferralToken(chatId);
            const { text, keyboard, parseMode } = await buildBonusMessage(bot, chatId);
            await safeEdit(chatId, messageId, text, {
                parse_mode: parseMode || 'HTML',
                reply_markup: keyboard,
                skipEmojiWrap: true
            });
            return await safeAnswer({ text: "Yangi havola yaratildi (5 kun)", show_alert: false });
        }

        if (data.startsWith('admin_coins_') && chatId.toString() === config.adminId.toString()) {
            if (data.startsWith('admin_coins_deduct_')) {
                const targetId = data.replace('admin_coins_deduct_', '');
                const u = await User.findOne({ where: { chatId: targetId } });
                global.userStates[chatId] = { step: 'WAITING_COIN_DEDUCT', targetId };
                await safeAnswer();
                bot.sendMessage(
                    chatId,
                    `➖ User \`${targetId}\` dan nechta **coin** yechib olasiz?\n\nHozirgi balans: **${u?.coins || 0}** coin\n(Masalan: \`5\` yoki \`25\`)`,
                    { parse_mode: 'Markdown', skipEmojiWrap: true }
                );
                return;
            }
            if (data.startsWith('admin_coins_set_')) {
                const targetId = data.replace('admin_coins_set_', '');
                global.userStates[chatId] = { step: 'WAITING_COIN_SET', targetId };
                const u = await User.findOne({ where: { chatId: targetId } });
                await safeAnswer();
                bot.sendMessage(
                    chatId,
                    `✏️ User \`${targetId}\` uchun yangi **coin** miqdorini yuboring.\nHozirgi: **${u?.coins || 0}**`,
                    { parse_mode: 'Markdown', skipEmojiWrap: true }
                );
                return;
            }
        }

        if (data === "coin_redeem_month") {
            try {
                const { newCoins, expireAt } = await redeemCoinsForMonth(bot, chatId);
                const expStr = expireAt.toLocaleDateString('uz-UZ');
                await safeAnswer({ text: "1 oylik obuna faollashtirildi!", show_alert: true });
                const { text, keyboard } = await buildCoinMessage(chatId);
                await safeEdit(
                    chatId,
                    messageId,
                    `✅ **1 oylik obuna sotib olindi!**\n\n🪙 Qolgan coin: **${newCoins}**\n📅 Muddat: ${expStr}\n\n${text}`,
                    { parse_mode: "Markdown", reply_markup: keyboard, skipEmojiWrap: true }
                );
                await bot.sendMessage(
                    chatId,
                    '🎉 Endi /start ni bosing — bot funksiyalaridan foydalanishingiz mumkin.',
                    getMainMenu(chatId)
                );
            } catch (e) {
                await safeAnswer({ text: e.message, show_alert: true });
            }
            return;
        }

        // --- 2. SUBSCRIPTION CHECK ---
        const isMember = await checkMembership(bot, chatId);
        const skipSubCheck = isBonusCallback || data === "check_subscription";
        if (!isMember && !skipSubCheck) {
            await safeAnswer({ text: "⚠️ Botdan foydalanish uchun avval kanallarga a'zo bo'ling!", show_alert: true });
            return sendSubscriptionAsk(bot, chatId);
        }

        if (data === "check_subscription") {
            const isMemberNow = await checkMembership(bot, chatId);
            if (isMemberNow) {
                try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
                await processSubscriptionReferralReward(bot, chatId);
                await bot.sendMessage(
                    chatId,
                    "✅ **Rahmat!** Siz barcha kanallarga a'zo bo'ldingiz.\n\n/start ni bosing.",
                    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [getBonusCoinRow()] } }
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
                await safeEdit(chatId, messageId, "📋 **Menyu:**\n\nBonus bo'limi:", {
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: [getBonusCoinRow()] }
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
            const { getAvtoUserGroupPickerKeyboard } = require('../utils/helpers');
            global.userStates[chatId] = { step: 'WAITING_SCRAPE_LINK' };
            await bot.sendMessage(
                chatId,
                "🔗 **Guruh linkini yuboring yoki tanlang.**",
                { parse_mode: "Markdown", reply_markup: getAvtoUserGroupPickerKeyboard() }
            );
            return await safeAnswer();
        }

        if (data === "menu_reyd") {
            const { getReydMenu } = require('../utils/helpers');
            const accCount = user.reydAccounts ? user.reydAccounts.length : 0;
            
            await safeEdit(chatId, messageId, "⚔️ **Reyd bo'limi**\n\nSiz bir nechta akkaunt ulab, reydni yanada tezroq va samaraliroq amalga oshirishingiz mumkin. Akkauntlar navbatma-navbat xabar yuboradi.", {
                parse_mode: "Markdown",
                ...getReydMenu(accCount)
            });
            return await safeAnswer();
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
            const { getGroupPickerKeyboard, REYD_CHAT_REQUEST_ID } = require('../utils/helpers');
            global.userStates[chatId] = { step: 'WAITING_REYD_TARGET' };
            bot.sendMessage(chatId, "⚔️ Reyd qilinadigan guruh linki yoki usernameni yuboring:", {
                reply_markup: getGroupPickerKeyboard(REYD_CHAT_REQUEST_ID)
            });
            return await safeAnswer();
        }

        if (data === "menu_reklama") {
            const { getReklamaMenu } = require('../utils/helpers');
            const accCount = user.reklamaAccounts ? user.reklamaAccounts.length : 0;
            
            await safeEdit(chatId, messageId, "🚀 **Reklama bo'limi**\n\nSiz bir nechta akkaunt ulab, reklamani yanada ko'proq odamga yuborishingiz mumkin. Akkaunt spamga tushsa, bot avtomatik keyingisiga o'tadi.", {
                parse_mode: "Markdown",
                ...getReklamaMenu(accCount)
            });
            return await safeAnswer();
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

        if (data === "admin_all_users" || data.startsWith('admin_list_') || data === "admin_pending" || data === "admin_approved" || data === "admin_blocked") { 
            let page = 1;
            let statusFilter = 'all';

            if (data.startsWith('admin_list_')) {
                const parts = data.split('_');
                page = parseInt(parts[2]) || 1;
                statusFilter = parts[3] || 'all';
            } else if (data === "admin_pending") {
                statusFilter = 'pending';
            } else if (data === "admin_approved") {
                statusFilter = 'approved';
            } else if (data === "admin_blocked") {
                statusFilter = 'blocked';
            }

            const limit = 10;
            const where = statusFilter === 'all' ? {} : { status: statusFilter };
            const total = await User.count({ where }); 
            const users = await User.findAll({ 
                where, 
                order: [['joinedAt', 'DESC']], 
                offset: (page - 1) * limit, 
                limit 
            }); 
            
            let statusTitle = "Barcha A'zolar";
            if (statusFilter === 'pending') statusTitle = "Kutilayotganlar";
            if (statusFilter === 'approved') statusTitle = "Tasdiqlanganlar";
            if (statusFilter === 'blocked') statusTitle = "Bloklanganlar";

            const totalPages = Math.ceil(total / limit) || 1;
            let text = `👥 **${statusTitle}:** (Sahifa ${page}/${totalPages})\n\n`; 
            
            users.forEach((u, i) => {
                const statusEmoji = u.status === 'approved' ? '✅' : (u.status === 'blocked' ? '🚫' : '⏳');
                const name = u.name || "Noma'lum";
                const username = u.username ? `(@${u.username})` : "";
                
                const date = u.joinedAt ? new Date(u.joinedAt) : new Date();
                const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                
                text += `👤 ${name} ${username} ${statusEmoji}\n`;
                text += `🆔 \`${u.chatId}\` | /info_${u.chatId}\n`;
                text += `📅 ${formattedDate}\n\n`;
            }); 
            
            const nav = []; 
            if (page > 1) nav.push({ text: "⬅️ Oldingi", callback_data: `admin_list_${page-1}_${statusFilter}` }); 
            if (total > page * limit) nav.push({ text: "Keyingi ➡️", callback_data: `admin_list_${page+1}_${statusFilter}` }); 
            
            await safeEdit(chatId, messageId, text, { 
                parse_mode: "Markdown", 
                reply_markup: { 
                    inline_keyboard: [
                        nav, 
                        [{ text: "🔙 Orqaga", callback_data: "admin_panel" }]
                    ] 
                } 
            }); 
            return await safeAnswer();
        } 

        if (data.startsWith('admin_approve_1month_')) { 
            const targetId = data.split('_')[3]; 
            const expireAt = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)); // 30 kun
            await User.update({ status: 'approved', subscriptionType: 'Standard', expireAt, expiryWarningSent: false }, { where: { chatId: targetId } }); 
            triggerBackup('admin_tasdiq_1oy', true);
            
            bot.sendMessage(chatId, `✅ User ${targetId} 1 oyga Standard qilib tasdiqlandi.`); 
            bot.sendMessage(targetId, "🎉 Siz admin tomonidan tasdiqlandingiz! \n\n 🔰 Tarif: 1 oy \n Endi /start ni bosib ro'yxatdan o'tishingiz mumkin."); 
            
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            return await safeAnswer();
        }

        if (data.startsWith('admin_approve_vip_')) { 
            const targetId = data.split('_')[3]; 
            await User.update({ status: 'approved', subscriptionType: 'VIP', expireAt: null, expiryWarningSent: false }, { where: { chatId: targetId } }); 
            triggerBackup('admin_tasdiq_vip', true);
            
            bot.sendMessage(chatId, `👑 User ${targetId} **Cheksiz VIP** qilib tasdiqlandi.`); 
            bot.sendMessage(targetId, "🎉 Siz admin tomonidan tasdiqlandingiz! \n\n 🔰 Tarif: 👑 VIP \n Endi /start ni bosib ro'yxatdan o'tishingiz mumkin."); 
            
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            return await safeAnswer();
        }

        if (data.startsWith('admin_approve_')) { 
            const targetId = data.split('_')[2]; 
            global.userStates[chatId] = { step: 'WAITING_TIME', targetId }; 
            bot.sendMessage(chatId, "✍️ Muddatni kiriting (Masalan: `1 oy`, `7 kun`, `2 soat`):"); 
            return await safeAnswer();
        } 

        if (data.startsWith('admin_block_')) {
            const targetId = data.split('_')[2];
            await User.update({ status: 'blocked', session: null }, { where: { chatId: targetId } });
            triggerBackup('admin_blok', true);
            bot.sendMessage(chatId, `🚫 User ${targetId} bloklandi.`);
            
            const blockedText = `⚠ Sizning foydalanish muddatingiz tugagan. \nBotdan foydalanishni davom ettirish uchun to'lovni amalga oshiring va botni qayta ishga tushiring. \n\n👨‍💼 Admin: @ortiqov_x7`;
            bot.sendMessage(targetId, blockedText, {
                reply_markup: {
                    inline_keyboard: [[{ text: "👨‍💼 Admin bilan bog'lanish", url: "https://t.me/ortiqov_x7" }]]
                }
            });
            return await safeAnswer();
        }

        if (data.startsWith('admin_unblock_')) {
            const targetId = data.split('_')[2];
            await User.update({ status: 'pending' }, { where: { chatId: targetId } });
            bot.sendMessage(chatId, `✅ User ${targetId} blokdan ochildi (status: pending).`);
            bot.sendMessage(targetId, "✅ Siz admin tomonidan blokdan ochildingiz. Endi qayta ro'yxatdan o'tishingiz mumkin.");
            return await safeAnswer();
        }

        if (data === "admin_broadcast") { 
            global.userStates[chatId] = { step: 'WAITING_BROADCAST' }; 
            bot.sendMessage(chatId, "📣 Barchaga yuboriladigan xabarni yuboring:"); 
            return await safeAnswer();
        } 

        // --- 4. CHANNELS MANAGEMENT ---
        if (data === "admin_channels") {
            if (chatId.toString() !== config.adminId.toString()) return;
            const channels = await Channel.findAll();
            let text = "📢 **Majburiy obuna kanallari:**\n\n";
            const buttons = [];
            
            if (channels.length === 0) {
                text += "Hozircha kanallar qo'shilmagan.";
            } else {
                channels.forEach(c => {
                    text += `🔹 **${c.name}**\nID: \`${c.channelId}\`\nURL: ${c.url}\n\n`;
                    buttons.push([{ text: `❌ ${c.name} ni o'chirish`, callback_data: `admin_del_channel_${c.id}` }]);
                });
            }
            
            buttons.push([{ text: "➕ Yangi kanal qo'shish", callback_data: "admin_add_channel" }]);
            buttons.push([{ text: "🔙 Orqaga", callback_data: "admin_panel" }]);
            
            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: buttons }
            });
            return await safeAnswer();
        }

        if (data === "admin_add_channel") {
            if (chatId.toString() !== config.adminId.toString()) return;
            global.userStates[chatId] = { step: 'WAITING_CHANNEL_ID' };
            bot.sendMessage(chatId, "🆔 Yangi kanalning **ID raqamini** yuboring (Masalan: `-100123456789`):");
            return await safeAnswer();
        }

        if (data.startsWith("admin_del_channel_")) {
            if (chatId.toString() !== config.adminId.toString()) return;
            const channelId = data.split('_')[3];
            await Channel.destroy({ where: { id: channelId } });
            await safeAnswer({ text: "✅ Kanal o'chirildi!", show_alert: true });
            
            // Kanallar ro'yxatini yangilash
            const channels = await Channel.findAll();
            let text = "📢 **Majburiy obuna kanallari:**\n\n";
            const buttons = [];
            if (channels.length === 0) {
                text += "Hozircha kanallar qo'shilmagan.";
            } else {
                channels.forEach(c => {
                    text += `🔹 **${c.name}**\nID: \`${c.channelId}\`\nURL: ${c.url}\n\n`;
                    buttons.push([{ text: `❌ ${c.name} ni o'chirish`, callback_data: `admin_del_channel_${c.id}` }]);
                });
            }
            buttons.push([{ text: "➕ Yangi kanal qo'shish", callback_data: "admin_add_channel" }]);
            buttons.push([{ text: "🔙 Orqaga", callback_data: "admin_panel" }]);
            
            await safeEdit(chatId, messageId, text, {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: buttons }
            });
            return;
        }

        // --- ADMIN: BONUS TIZIMI ---
        if (data === "admin_bonus") {
            if (chatId.toString() !== config.adminId.toString()) return;
            const enabled = await isBonusEnabled();
            const stats = await getAdminBonusStats();
            const statusText = enabled ? '🟢 Faol (demo)' : '🔴 Nofaol';
            const text =
                `🎁 **Bonus / Referral tizimi**\n\n` +
                `Holat: ${statusText}\n\n` +
                `🪙 Jami coinlar (barcha userlar): ${stats.totalCoins}\n` +
                `👥 Referrallar: ${stats.totalReferrals} (coin berilgan: ${stats.rewardedReferrals})\n` +
                `⏳ Kutilmoqda: ${stats.pendingReferrals}\n` +
                `✅ Coin bilan 1 oy olganlar: ${stats.totalRedemptions} marta\n` +
                `👤 Coini bor userlar: ${stats.usersWithCoins}\n\n` +
                `📌 Qoida: yangi user → kanal obunasi → referrer +1 coin\n` +
                `💰 ${COINS_PER_MONTH} coin = 1 oylik obuna`;

            const toggleLabel = enabled ? '🔴 O\'chirish' : '🟢 Yoqish';
            await safeEdit(chatId, messageId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: toggleLabel, callback_data: 'admin_bonus_toggle' }],
                        [{ text: '🏆 Top 10 ', callback_data: 'admin_bonus_top10' }],
                        [{ text: '✅ Coin redem', callback_data: 'admin_bonus_redeemed' }],
                        [{ text: '🔙 Admin panel', callback_data: 'admin_panel' }]
                    ]
                }
            });
            return await safeAnswer();
        }

        if (data === "admin_bonus_toggle") {
            if (chatId.toString() !== config.adminId.toString()) return;
            const enabled = await isBonusEnabled();
            await setBonusEnabled(!enabled);
            await safeAnswer({ text: !enabled ? 'Bonus yoqildi' : 'Bonus o\'chirildi', show_alert: true });
            const stats = await getAdminBonusStats();
            const statusText = !enabled ? '🟢 Yoqilgan (demo)' : '🔴 O\'chirilgan';
            const text =
                `🎁 **Bonus / Referral tizimi**\n\nHolat: ${statusText}\n\n` +
                `🪙 Jami coinlar: ${stats.totalCoins}\n` +
                `👥 Referrallar: ${stats.totalReferrals}\n` +
                `✅ Coin bilan 1 oy: ${stats.totalRedemptions} marta`;
            const toggleLabel = !enabled ? '🔴 Bonusni o\'chirish' : '🟢 Bonusni yoqish';
            await safeEdit(chatId, messageId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: toggleLabel, callback_data: 'admin_bonus_toggle' }],
                        [{ text: '🏆 Top 10 referrer', callback_data: 'admin_bonus_top10' }],
                        [{ text: '✅ Coin bilan olganlar', callback_data: 'admin_bonus_redeemed' }],
                        [{ text: '🔙 Admin panel', callback_data: 'admin_panel' }]
                    ]
                }
            });
            return;
        }

        if (data === "admin_bonus_top10") {
            if (chatId.toString() !== config.adminId.toString()) return;
            const top = await getTop10Referrers();
            let text = '🏆 **Top 10 referrerlar:**\n\n';
            if (top.length === 0) {
                text += 'Hali ma\'lumot yo\'q.';
            } else {
                top.forEach((r, i) => {
                    const un = r.username ? `@${r.username}` : '';
                    text += `${i + 1}. ${r.name} ${un}\n`;
                    text += `   🆔 \`${r.chatId}\` | 🪙 ${r.coins} | ✅ ${r.rewarded}/${r.total}\n\n`;
                });
            }
            await safeEdit(chatId, messageId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Bonus', callback_data: 'admin_bonus' }]]
                }
            });
            return await safeAnswer();
        }

        if (data === "admin_bonus_redeemed") {
            if (chatId.toString() !== config.adminId.toString()) return;
            const list = await getCoinRedeemers(25);
            let text = '✅ **Coin bilan 1 oylik obuna olganlar:**\n\n';
            if (list.length === 0) {
                text += 'Hali hech kim sotib olmagan.';
            } else {
                list.forEach((u) => {
                    const un = u.username ? `@${u.username}` : '';
                    text += `👤 ${u.name || '—'} ${un}\n🆔 \`${u.chatId}\` | 🪙 ${u.coins} | 🔄 ${u.coinRedemptions}x\n\n`;
                });
            }
            text += '\n_Ushbu foydalanuvchilar `approved` (Coin Bonus) holatida._';
            await safeEdit(chatId, messageId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Bonus', callback_data: 'admin_bonus' }]]
                }
            });
            return await safeAnswer();
        }

        await safeAnswer(); 
    });
};


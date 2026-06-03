const fs = require('fs');
const path = require('path');
const User = require('../models/User');
const Channel = require('../models/Channel');
const config = require('../config');
const {
    parseTime,
    checkMembership,
    sendSubscriptionAsk,
    normalizeTelegramUrl,
    SCRAPE_CHAT_REQUEST_ID,
    REYD_CHAT_REQUEST_ID,
    UTAG_CHAT_REQUEST_ID,
    parseSharedGroup,
    normalizePhoneInput,
    removeKeyboardMarkup,
    getPhoneShareKeyboard,
    getUtagSetupKeyboard,
    getUtagModeKeyboard
} = require('../utils/helpers');
const { triggerBackup } = require('../utils/dbBackup');
const { adminSetCoins, adminAdjustCoins } = require('../services/bonus');
const { initAuth, handleAuthStep, scrapeUsers, startReyd, startReklama, startAutoTag } = require('../services/userbot');

if (!global.userStates) global.userStates = {};

module.exports = (bot) => {
    bot.on('message', async (msg) => { 
        const chatId = msg.chat.id; 
        const text = msg.text;
        const state = global.userStates[chatId]; 

        // 1. Agar xabar buyruq bo'lsa, uni commands.js ga topshiramiz
        if (text && (text.startsWith('/') || (msg.entities && msg.entities.some(e => e.type === 'bot_command')))) {
            return;
        }
        
        // 2. Majburiy obuna tekshiruvi (faqat matnli xabarlar va holati bor userlar uchun)
        if (state) {
            const isMember = await checkMembership(bot, chatId);
            if (!isMember) {
                return sendSubscriptionAsk(bot, chatId);
            }
        }
        
        // 3. Agar hech qanday holatda bo'lmasa, xabarni e'tiborsiz qoldiramiz
        if (!state) return;

        // 4. Session check for features
        if (!['WAITING_PHONE', 'WAITING_CODE', 'WAITING_PASSWORD', 'WAITING_TIME', 'WAITING_BROADCAST', 'WAITING_COIN_SET', 'WAITING_COIN_DEDUCT'].includes(state.step)) {
            const user = await User.findOne({ where: { chatId } });
            if (!user || !user.session) {
                delete global.userStates[chatId];
                return bot.sendMessage(chatId, "⚠️ Botdan foydalanish uchun avval Telegram akkauntingiz bilan tizimga kiring. /start ni bosing.");
            }
        }

        // Auth logic
        if (state.step === 'WAITING_PHONE') {
            let phoneRaw = null;
            if (msg.contact && msg.contact.phone_number) {
                phoneRaw = msg.contact.phone_number;
            } else if (text) {
                phoneRaw = text;
            }
            if (!phoneRaw) return;
            try {
                const phoneNumber = normalizePhoneInput(phoneRaw);
                if (phoneNumber.length < 7) throw new Error("Noto'g'ri telefon raqami. Iltimos, xalqaro formatda kiriting (Masalan: +998991234567)");

                const isAdditional = state.isAdditional || false;
                const isReyd = state.isReyd || false;
                await bot.sendMessage(chatId, "⏳", { ...removeKeyboardMarkup() }).catch(() => {});
                await initAuth(chatId, phoneNumber, bot, isAdditional, isReyd);
                global.userStates[chatId] = { step: 'WAITING_CODE', phoneNumber, isAdditional, isReyd };
            } catch (e) {
                bot.sendMessage(chatId, `❌ Xatolik: ${e.message}\n\nQayta urinib ko'ring (Telefon raqam yuboring):`, {
                    reply_markup: getPhoneShareKeyboard()
                });
            }
            return;
        }

        if (state.step === 'WAITING_CODE' || state.step === 'WAITING_PASSWORD') {
            if (!text) return;
            try {
                await handleAuthStep(chatId, text, bot);
            } catch (e) {
                if (e.message === "AUTH_NOT_FOUND") {
                    bot.sendMessage(chatId, "❌ Sessiya topilmadi. Iltimos, /start bosing.");
                    delete global.userStates[chatId];
                } else {
                    bot.sendMessage(chatId, `❌ Xatolik: ${e.message}`);
                }
            }
            return;
        }

        // Admin logic
        if (chatId.toString() === config.adminId.toString()) {
            if (state.step === 'WAITING_TIME') { 
                if (!text) return;
                const duration = parseTime(text); 
                if (duration === 0) return bot.sendMessage(chatId, "❌ Noto'g'ri format! Qayta kiriting."); 
                const expireAt = new Date(Date.now() + duration); 
                await User.update({ status: 'approved', expireAt, expiryWarningSent: false }, { where: { chatId: state.targetId } }); 
                triggerBackup('admin_tasdiq_qolda', true);
                bot.sendMessage(chatId, `✅ Tasdiqlandi! Muddat: ${text}`); 
                bot.sendMessage(state.targetId, `🎉 Siz admin tomonidan tasdiqlandingiz! \n\n 🔰 Tarif: ${text} \n Endi /start ni bosib ro'yxatdan o'tishingiz mumkin.`); 
                delete global.userStates[chatId]; 
                return;
            } 
        
            if (state.step === 'WAITING_BROADCAST') { 
                const users = await User.findAll(); 
                bot.sendMessage(chatId, `🚀 ${users.length} kishiga yuborish boshlandi...`); 
                for (const u of users) { 
                    try { await bot.copyMessage(u.chatId, chatId, msg.message_id); } catch (e) {} 
                } 
                bot.sendMessage(chatId, "🏁 Yakunlandi!"); 
                delete global.userStates[chatId]; 
                return;
            } 

            if (state.step === 'WAITING_COIN_SET') {
                if (!text) return;
                const amount = parseInt(text.replace(/\s/g, ''), 10);
                if (Number.isNaN(amount) || amount < 0) {
                    return bot.sendMessage(chatId, "❌ 0 yoki undan katta butun son kiriting.");
                }
                try {
                    const { oldCoins, newCoins } = await adminSetCoins(state.targetId, amount, chatId);
                    bot.sendMessage(
                        chatId,
                        `✅ User \`${state.targetId}\`: ${oldCoins} → **${newCoins}** coin`,
                        { parse_mode: 'Markdown', skipEmojiWrap: true }
                    );
                    bot.sendMessage(
                        state.targetId,
                        `🪙 Admin tomonidan sizga **${newCoins}** ta coin xadiya qilindi.`,
                        { parse_mode: 'Markdown', skipEmojiWrap: true }
                    ).catch(() => {});
                } catch (e) {
                    bot.sendMessage(chatId, `❌ ${e.message}`);
                }
                delete global.userStates[chatId];
                return;
            }

            if (state.step === 'WAITING_COIN_DEDUCT') {
                if (!text) return;
                const amount = parseInt(text.replace(/\s/g, ''), 10);
                if (Number.isNaN(amount) || amount <= 0) {
                    return bot.sendMessage(chatId, "❌ 1 yoki undan katta butun son kiriting (masalan: 10).");
                }
                try {
                    const { newCoins, delta } = await adminAdjustCoins(state.targetId, -amount, chatId);
                    bot.sendMessage(
                        chatId,
                        `✅ User \`${state.targetId}\` dan **${amount}** coin yechildi.\nYangi balans: **${newCoins}** coin`,
                        { parse_mode: 'Markdown', skipEmojiWrap: true }
                    );
                    // bot.sendMessage(
                    //     state.targetId,
                    //     `🪙 Admin hisobingizdan **${amount}** coin yechildi.\nQolgan: **${newCoins}** coin`,
                    //     { parse_mode: 'Markdown', skipEmojiWrap: true }
                    // ).catch(() => {});
                } catch (e) {
                    bot.sendMessage(chatId, `❌ ${e.message}`);
                }
                delete global.userStates[chatId];
                return;
            }

            if (state.step === 'WAITING_CHANNEL_ID') {
                if (!text) return;
                global.userStates[chatId] = { step: 'WAITING_CHANNEL_NAME', channelId: text };
                bot.sendMessage(chatId, "✍️ Kanal uchun **nom** kiriting:");
                return;
            }

            if (state.step === 'WAITING_CHANNEL_NAME') {
                if (!text) return;
                global.userStates[chatId] = { ...state, step: 'WAITING_CHANNEL_URL', name: text };
                bot.sendMessage(chatId, "🔗 Kanal **linkini** yuboring:\n`https://t.me/kanal` yoki `@kanal` yoki `kanal`");
                return;
            }

            if (state.step === 'WAITING_CHANNEL_URL') {
                if (!text) return;
                const normalizedUrl = normalizeTelegramUrl(text);
                if (!normalizedUrl) {
                    return bot.sendMessage(
                        chatId,
                        "❌ Noto'g'ri link. Quyidagilardan birini yuboring:\n`https://t.me/kanal_nomi`\n`@kanal_nomi`\n`kanal_nomi`",
                        { parse_mode: 'Markdown' }
                    );
                }
                try {
                    await Channel.create({
                        channelId: state.channelId,
                        name: state.name,
                        url: normalizedUrl
                    });
                    bot.sendMessage(chatId, `✅ Kanal qo'shildi!\nLink: ${normalizedUrl}`);
                    delete global.userStates[chatId];
                } catch (e) {
                    bot.sendMessage(chatId, "❌ Xatolik: " + e.message);
                }
                return;
            }
        }

        // Features logic
        if (state.step === 'WAITING_SCRAPE_LINK') {
            if (msg.chat_shared && msg.chat_shared.request_id === SCRAPE_CHAT_REQUEST_ID) {
                const { id: groupId, title } = parseSharedGroup(msg.chat_shared);
                global.userStates[chatId] = { step: 'WAITING_SCRAPE_LIMIT', groupLink: groupId };
                await bot.sendMessage(
                    chatId,
                    `✅ **${title}** tanlandi.\n\n🔢 Nechta User yig'moqchisiz? (Maximum 2000):`,
                    { parse_mode: "Markdown", ...removeKeyboardMarkup() }
                );
                return;
            }

            if (!text) return;
            global.userStates[chatId] = { step: 'WAITING_SCRAPE_LIMIT', groupLink: text.trim() };
            await bot.sendMessage(
                chatId,
                "🔢 Nechta User yig'moqchisiz? (Maximum 2000):",
                { parse_mode: "Markdown", ...removeKeyboardMarkup() }
            );
            return;
        }

        if (state.step === 'WAITING_SCRAPE_LIMIT') {
            if (!text) return;
            const limit = parseInt(text) || 100;
            const groupLink = state.groupLink;
            
            delete global.userStates[chatId];
            
            bot.sendMessage(chatId, "⏳ **Userlarni yig'ish boshlanmoqda...**\nBiroz vaqt olishi mumkin **Iltimos** sabirli bo'ling .");
            
            scrapeUsers(chatId, groupLink, limit, bot).catch(e => {
                bot.sendMessage(chatId, `❌ Xatolik: Guruh linki eskirgan bo'lishi mumkin.\nGuruha borligingizni tekshiring.`);
            });
            return;
        }

        if (state.step === 'WAITING_REYD_TARGET') {
            if (msg.chat_shared && msg.chat_shared.request_id === REYD_CHAT_REQUEST_ID) {
                const { id, title } = parseSharedGroup(msg.chat_shared);
                global.userStates[chatId] = { ...state, step: 'WAITING_REYD_TEXT', target: id, groupTitle: title };
                await bot.sendMessage(chatId, "📩 Reyd xabarini (matn yoki stiker) yuboring:", removeKeyboardMarkup());
                return;
            }
            if (!text) return;
            global.userStates[chatId] = { ...state, step: 'WAITING_REYD_TEXT', target: text.trim() };
            await bot.sendMessage(chatId, "📩 Reyd xabarini (matn yoki stiker) yuboring:", removeKeyboardMarkup());
            return;
        } else if (state.step === 'WAITING_REYD_TEXT') {
            let stickerPath = null;
            if (msg.sticker) {
                try {
                    const tempDir = path.join(process.cwd(), 'temp');
                    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
                    stickerPath = await bot.downloadFile(msg.sticker.file_id, tempDir);
                } catch (err) {
                    console.error("Stiker yuklash xatosi:", err.message);
                    return bot.sendMessage(chatId, "❌ Stiker yuklashda xatolik yuz berdi. Qaytadan urinib ko'ring.");
                }
            }
            global.userStates[chatId] = { ...state, step: 'WAITING_REYD_LIMIT', reydMsg: msg, stickerPath };
            bot.sendMessage(chatId, "🔢 Nechta xabar yuborilsin? (Maksimum 500):");
        } else if (state.step === 'WAITING_REYD_LIMIT') {
            if (!text) return;
            const limit = parseInt(text) || 10;
            const reydData = { ...state, limit };
            global.userStates[chatId] = { ...reydData, step: 'CONFIRM_REYD' };
            
            const reydInfo = `🛡 **Reyd Ma'lumotlari:**\n\n` +
                `📍 Nishon: ${reydData.groupTitle || reydData.target}\n` +
                `🔢 Soni: ${reydData.limit} ta\n` +
                `📩 Xabar turi: ${reydData.reydMsg.sticker ? "Stiker" : "Matn"}\n\n` +
                `Tayyormisiz? "Boshlash" tugmasini bosing.`;

            bot.sendMessage(chatId, reydInfo, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🚀 Boshlash", callback_data: "reyd_start_confirm" }],
                        [{ text: "❌ Bekor qilish", callback_data: "reyd_cancel" }]
                    ]
                }
            });
        }

        if (state.step === 'WAITING_REK_USERS') {
            if (!text) return;
            global.userStates[chatId] = { step: 'WAITING_REK_TEXT', usersList: text };
            bot.sendMessage(chatId, "✍️ Reklama xabarini yuboring (Matn, rasm, stiker va h.k.):");
        } else if (state.step === 'WAITING_REK_TEXT') {
            global.userStates[chatId] = { ...state, step: 'CONFIRM_REK', reklamaMsg: msg };
            
            const rekInfo = `📢 **Reklama Ma'lumotlari:**\n\n` +
                `👥 Userlar soni: ${state.usersList.split(/\s+/).filter(u => u.startsWith('@')).length} ta\n` +
                `📩 Xabar turi: ${msg.photo ? "Rasm" : (msg.sticker ? "Stiker" : (msg.video ? "Video" : "Matn"))}\n\n` +
                `Tayyormisiz? "Boshlash" tugmasini bosing.`;

            bot.sendMessage(chatId, rekInfo, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🚀 Boshlash", callback_data: "reklama_start_confirm" }],
                        [{ text: "❌ Bekor qilish", callback_data: "reklama_cancel" }]
                    ]
                }
            });
        }

        if (state.step === 'WAITING_UTAG_LINK') {
            if (msg.chat_shared && msg.chat_shared.request_id === UTAG_CHAT_REQUEST_ID) {
                const { id, title } = parseSharedGroup(msg.chat_shared);
                global.userStates[chatId] = { ...state, step: 'WAITING_UTAG_SETUP', groupLink: id, groupTitle: title };
                await bot.sendMessage(chatId, "⏳", removeKeyboardMarkup()).catch(() => {});
                await bot.sendMessage(chatId,
                    `📍 **${title}**\n\nKimlarni tag qilamiz?\n• 🟢 Faqat online\n• 👥 Hammani\n\n• Yoki **faqat raqam** yuboring (masalan: 50)`,
                    { parse_mode: 'Markdown', ...getUtagSetupKeyboard() }
                );
                return;
            }
            if (!text) return;
            global.userStates[chatId] = { ...state, step: 'WAITING_UTAG_SETUP', groupLink: text.trim() };
            await bot.sendMessage(chatId, "⏳", removeKeyboardMarkup()).catch(() => {});
            await bot.sendMessage(chatId,
                "Kimlarni tag qilamiz?\n• 🟢 Faqat online\n• 👥 Hammani\n\n• Yoki **faqat raqam** yuboring (masalan: 50)",
                { parse_mode: 'Markdown', ...getUtagSetupKeyboard() }
            );
            return;
        }

        if (state.step === 'WAITING_UTAG_SETUP') {
            if (!text) return;
            if (!/^\d+$/.test(text.trim())) {
                return bot.sendMessage(chatId, "❌ Faqat raqam kiriting (masalan: 50) yoki tugmalardan tanlang.");
            }
            const limit = parseInt(text.trim(), 10);
            global.userStates[chatId] = { ...state, step: 'WAITING_UTAG_MODE', limit, memberFilter: 'all' };
            return bot.sendMessage(chatId, "🛠 **Tag rejimini tanlang:**", {
                parse_mode: 'Markdown',
                ...getUtagModeKeyboard()
            });
        }

        if (state.step === 'WAITING_UTAG_CUSTOM_TEXT') {
            if (!text) return;
            const utagData = { ...state };
            delete global.userStates[chatId];

            bot.sendMessage(chatId, "🚀 Utag jarayoni boshlanmoqda...");
            startAutoTag(chatId, utagData.groupLink, bot, {
                limit: utagData.limit ?? 0,
                mode: 'custom',
                tagText: text,
                memberFilter: utagData.memberFilter || 'all',
                groupTitle: utagData.groupTitle
            }).catch((err) => bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`));
            return;
        }
    });
};


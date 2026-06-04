/**
 * Reklama (Advertising) Service
 * Foydalanuvchilarga reklama yuborish (spam himoyasi bilan)
 * (Kodlar originaldan o'zgartirilmasdan ko'chirilgan)
 */

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const config = require("../../config");
const User = require("../../models/User");
const PremiumAd = require("../../models/PremiumAd");
const { convertToGramJsEntities, getMainMenu } = require('../../utils/helpers');
const { reklamaStates, PROMO_REKLAMA, downloadFile } = require('../userbotState');
const { ensureClient } = require('../clientManager');

const startReklama = async (chatId, usersList, reklamaMsg, bot) => {
    const user = await User.findOne({ where: { chatId } });
    if (!user) throw new Error("Foydalanuvchi topilmadi.");

    const originalText = reklamaMsg.text || reklamaMsg.caption || "";
    const originalEntities = reklamaMsg.entities || reklamaMsg.caption_entities || [];
    const promoFooter = `\n\n${PROMO_REKLAMA()}`;
    const reklamaText = originalText ? `${originalText}${promoFooter}` : PROMO_REKLAMA();
    
    // GramJS uchun entitylarni konvertatsiya qilish (faqat asl matn entitylari)
    const entities = convertToGramJsEntities(originalEntities);

    // Reklamani vaqtinchalik bazaga saqlash
    await PremiumAd.upsert({
        chatId,
        content: {
            text: reklamaMsg.text,
            caption: reklamaMsg.caption,
            entities: reklamaMsg.entities,
            caption_entities: reklamaMsg.caption_entities,
            photo: reklamaMsg.photo,
            sticker: reklamaMsg.sticker,
            video: reklamaMsg.video
        },
        usersList,
        status: 'running'
    });

    // Akkauntlarni tayyorlash
    let sessions = [];
    let clients = [];
    const mode = user.reklamaAccountMode || 'main'; // Default 'main'

    if (mode === 'main') {
        // Asosiy akkaunt rejimi — faqat asosiyni ishlatamiz
        sessions = [user.session];
    } else if (mode === 'all') {
        // Barcha akkauntlar rejimi — faqat qo'shimcha akkauntlarni ishlatamiz!
        const reklamaAccs = (user.reklamaAccounts || []).map(acc => acc.session).filter(Boolean);
        if (reklamaAccs.length === 0) {
            // Qo'shimcha akkaunt yo'q bo'lsa xabar beramiz
            await bot.sendMessage(chatId, "❌ Sizda hech qanday qo'shimcha reklama akkaunti ulanmagan! Iltimos, akkaunt qo'shish uchun botda kerakli bo'limdan foydalaning.");
            return;
        }
        sessions = reklamaAccs;
    }

    if (sessions.length === 0) {
        throw new Error("Reklama uchun asosiy yoki qo'shimcha akkauntlar ulanmagan.");
    }

    const users = usersList.split(/\s+/).filter(u => u.startsWith('@')).slice(0, 500);
    
    let currentSessionIndex = 0;
    let count = 0;

    reklamaStates[chatId] = { status: 'running', count: 0, total: users.length, sessionIndex: 0 };

    const getReklamaButtons = (status) => {
        const buttons = [];
        if (status === 'running') buttons.push({ text: "⏸ Pauza", callback_data: "reklama_pause" });
        if (status === 'paused') buttons.push({ text: "▶️ Davom etish", callback_data: "reklama_resume" });
        buttons.push({ text: "⏹ To'xtatish", callback_data: "reklama_stop" });
        return { reply_markup: { inline_keyboard: [buttons] } };
    };

    const statusMsg = await bot.sendMessage(chatId, `🚀 **Reklama boshlandi!**\nAkkauntlar soni: ${sessions.length}\nUserlar soni: ${users.length}`, getReklamaButtons('running'));

    let client = null;
    // clients array will hold connected clients

    const connectClient = async (index) => {
        if (clients[index]) return clients[index];
        let newClient;
        
        if (mode === 'main' && index === 0) {
            // Asosiy akkaunt uchun ensureClient dan foydalanamiz
            newClient = await ensureClient(chatId, bot);
        } else {
            // Qo'shimcha akkauntlar uchun yangi klient yaratamiz
            newClient = new TelegramClient(new StringSession(sessions[index]), config.apiId, config.apiHash, {
                connectionRetries: 50,
                requestRetries: 15,
                timeout: 120000,
                autoReconnect: true,
                floodSleepThreshold: 120,
                useWSS: false,
                proxy: undefined
            });
            await newClient.connect();
            if (!(await newClient.checkAuthorization())) {
                throw new Error(`[Reklama] Akkaunt ${index} avtorizatsiyadan o'tolmadi.`);
            }
        }
        
        clients[index] = newClient;
        reklamaStates[chatId].sessionIndex = index;
        client = newClient;
        return newClient;
    };

    try {
        await connectClient(currentSessionIndex);

        // Mediani bir marta yuklab olish va Telegramga upload qilish (Optimallashtirish)
        let mediaBuffer = null;
        let uploadedFile = null;
        try {
            if (reklamaMsg.photo) {
                const file = await bot.getFile(reklamaMsg.photo[reklamaMsg.photo.length - 1].file_id);
                mediaBuffer = await downloadFile(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
            } else if (reklamaMsg.sticker) {
                const file = await bot.getFile(reklamaMsg.sticker.file_id);
                mediaBuffer = await downloadFile(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
            } else if (reklamaMsg.video) {
                const file = await bot.getFile(reklamaMsg.video.file_id);
                mediaBuffer = await downloadFile(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
            }

            if (mediaBuffer && client) {
                uploadedFile = await client.uploadFile({ file: mediaBuffer, workers: 1 });
            }
        } catch (downloadErr) {
            console.error(`[Media Download/Upload Error] ${chatId}:`, downloadErr.message);
            bot.sendMessage(chatId, `⚠️ Media yuklashda xatolik: ${downloadErr.message}. Reklama faqat matn ko'rinishida davom etadi.`);
            reklamaMsg.photo = null;
            reklamaMsg.video = null;
            reklamaMsg.sticker = null;
        }

        for (let i = 0; i < users.length; i++) {
            while (reklamaStates[chatId]?.status === 'paused') {
                await new Promise(r => setTimeout(r, 1000));
            }
            if (!reklamaStates[chatId] || reklamaStates[chatId].status === 'stopped') break;

            const targetUser = users[i];
            let success = false;

            while (currentSessionIndex < sessions.length && !success) {
                try {
                    if (reklamaMsg.sticker) {
                        await client.sendFile(targetUser, {
                            file: uploadedFile || mediaBuffer,
                            attributes: [new Api.DocumentAttributeSticker({ alt: reklamaMsg.sticker.emoji || "", stickerset: new Api.InputStickerSetEmpty() })]
                        });
                    } else if (reklamaMsg.photo || reklamaMsg.video) {
                        await client.sendFile(targetUser, {
                            file: uploadedFile || mediaBuffer,
                            caption: reklamaText,
                            formattingEntities: entities
                        });
                    } else {
                        await client.sendMessage(targetUser, {
                            message: reklamaText,
                            formattingEntities: entities
                        });
                    }

                    success = true;
                    count++;
                    reklamaStates[chatId].count = count;

                    if (count % 5 === 0 || count === users.length) {
                        await bot.editMessageText(`🚀 **Reklama jarayoni...**\nProgress: ${count}/${users.length}\nAkkaunt: ${currentSessionIndex + 1}/${sessions.length}`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id,
                            ...getReklamaButtons(reklamaStates[chatId].status)
                        }).catch(() => {});
                    }
                    
                    // Sekundiga 2 ta xabar (500ms kechikish)
                    await new Promise(r => setTimeout(r, 500)); 
                } catch (err) {
                    console.error(`[Reklama Error] Akkaunt ${currentSessionIndex}:`, err.message);
                    const isSpam = err.message.includes("PEER_FLOOD") || err.message.includes("USER_PRIVACY_RESTRICTED") || err.message.includes("FLOOD_WAIT") || err.message.includes("Spam");
                    
                    if (isSpam) {
                        const nextAcc = currentSessionIndex + 1;
                        if (nextAcc < sessions.length) {
                            // Foydalanuvchidan so'rash
                            const spamInfo = `⚠️ **Akkaunt spamga tushdi!**\n\nAkkaunt: ${currentSessionIndex + 1}/${sessions.length}\nProgress: ${count}/${users.length}\n\nKeyingi akkauntga o'tib davom etaylikmi?`;
                            
                            bot.sendMessage(chatId, spamInfo, {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: "▶️ Davom etish", callback_data: "reklama_spam_continue" }],
                                        [{ text: "⏹ To'xtatish", callback_data: "reklama_spam_stop" }]
                                    ]
                                }
                            });

                            // Foydalanuvchi javobini kutish
                            const userDecision = await new Promise((resolve) => {
                                reklamaStates[chatId].resolveSpam = resolve;
                            });

                            if (userDecision) {
                                currentSessionIndex++;
                                bot.sendMessage(chatId, `🔄 Keyingi akkauntga o'tildi (${currentSessionIndex + 1}/${sessions.length})...`);
                                await connectClient(currentSessionIndex);
                                // Uploaded file link might still work, if not, it will fail and success=true will be false
                            } else {
                                bot.sendMessage(chatId, "⏹ Reklama foydalanuvchi tomonidan to'xtatildi.");
                                reklamaStates[chatId].status = 'stopped';
                                success = false;
                                break;
                            }
                        } else {
                            bot.sendMessage(chatId, "❌ Barcha akkauntlar spamga tushdi yoki tugadi.");
                            reklamaStates[chatId].status = 'stopped';
                            success = false;
                            break;
                        }
                    } else {
                        // Boshqa xatoliklar (masalan, noto'g'ri username) bo'lsa, bu userni tashlab ketamiz
                        success = true; 
                    }
                }
            }
        }
    } catch (e) {
        console.error("Reklama critical error:", e.message);
    }

    // Reklama tugadi.
    const wasStopped = reklamaStates[chatId]?.status === 'stopped';
    const finalLabel = wasStopped ? "to'xtatildi" : "tugadi";

    // Clientlarni yopish
    for (const cl of clients) {
        if (cl) { try { await cl.disconnect(); } catch (e) {} }
    }

    // Bazadan reklamani o'chirish
    await PremiumAd.destroy({ where: { chatId } });
    await User.increment({ adsCount: count }, { where: { chatId } });

    // 1) Status xabarini tahrirlab, natijani ko'rsatamiz (tugmalarni olib tashlaymiz)
    if (statusMsg && statusMsg.message_id) {
        await bot.editMessageText(
            `🏁 **Avto Reklama ${finalLabel}!**\nJami yuborildi: ${count}/${users.length} ta.`,
            {
                chat_id: chatId,
                message_id: statusMsg.message_id
            }
        ).catch(() => {});
    }

    // 2) Asosiy menyuni alohida xabarda chiqaramiz
    await bot.sendMessage(chatId, "📊 **Asosiy menyu:**", getMainMenu(chatId)).catch(() => {});

    delete reklamaStates[chatId];
    return count;
};

module.exports = {
    startReklama
};

/**
 * Reyd (Raid) Service
 * Guruh yoki userga ko'p marta xabar/stiker yuborish
 * (Kodlar originaldan o'zgartirilmasdan ko'chirilgan)
 */

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const config = require("../../config");
const User = require("../../models/User");
const { convertToGramJsEntities, getMainMenu } = require('../../utils/helpers');
const { userClients, reydSessions, downloadFile } = require('../userbotState');
const { ensureClient } = require('../clientManager');

const startReyd = async (chatId, target, reydMsg, limit, bot, savedPath = null) => {
    if (reydSessions[chatId] && reydSessions[chatId].status !== 'stopped') {
        throw new Error("Reyd allaqachon ishga tushirilgan.");
    }

    const user = await User.findOne({ where: { chatId } });
    if (!user) {
        throw new Error("Foydalanuvchi topilmadi.");
    }

    // Akkauntlarni tayyorlash
    let sessions = [];
    let clients = [];
    const mode = user.reydAccountMode || 'main'; // Default 'main'

    if (mode === 'main') {
        // Asosiy akkaunt rejimi — faqat asosiyni ishlatamiz
        sessions = [user.session];
        const mainClient = await ensureClient(chatId, bot);
        clients.push(mainClient);
    } else if (mode === 'all') {
        // Barcha akkauntlar rejimi — faqat qo'shimcha akkauntlarni ishlatamiz!
        const reydAccs = (user.reydAccounts || []).map(acc => acc.session).filter(Boolean);
        if (reydAccs.length === 0) {
            // Qo'shimcha akkaunt yo'q bo'lsa xabar beramiz
            await bot.sendMessage(chatId, "❌ Sizda hech qanday qo'shimcha reyd akkaunti ulanmagan! Iltimos, akkaunt qo'shish uchun botda kerakli bo'limdan foydalaning.");
            return;
        }
        sessions = reydAccs;

        // Faqat qo'shimcha akkauntlarni ulaymiz!
        for (let i = 0; i < sessions.length; i++) {
            try {
                const sessionStr = sessions[i];
                const tempChatId = `${chatId}_${i}`;
                const client = new TelegramClient(new StringSession(sessionStr), config.apiId, config.apiHash, { 
                    connectionRetries: 50,
                    requestRetries: 15,
                    timeout: 120000,
                    autoReconnect: true,
                    floodSleepThreshold: 120,
                    useWSS: false,
                    proxy: undefined
                });
                await client.connect();
                if (await client.checkAuthorization()) {
                    userClients[tempChatId] = client;
                    clients.push(client);
                } else {
                    console.error(`[Reyd] Akkaunt ${i + 1} (qo'shimcha) avtorizatsiyadan o'tolmadi.`);
                }
            } catch (e) {
                console.error(`[Reyd] Akkaunt ${i + 1} (qo'shimcha) ulanishda xato:`, e.message);
            }
        }

        // Agar hech qanday qo'shimcha akkaunt ulana olmasak xabar beramiz
        if (clients.length === 0) {
            await bot.sendMessage(chatId, "❌ Hech qanday qo'shimcha reyd akkaunti ulana olmadi! Iltimos, akkauntlaringizni tekshiring.");
            return;
        }
    }

    if (clients.length === 0) throw new Error("Reyd uchun aktiv akkauntlar topilmadi. Akkauntlarni qaytadan ulab ko'ring.");

    reydSessions[chatId] = { status: 'running', count: 0, total: limit, target };

    const getReydButtons = (status) => {
        const buttons = [];
        if (status === 'running') buttons.push({ text: "⏸ Pauza", callback_data: "reyd_pause" });
        if (status === 'paused') buttons.push({ text: "▶️ Davom etish", callback_data: "reyd_resume" });
        buttons.push({ text: "⏹ To'xtatish", callback_data: "reyd_stop" });
        return { reply_markup: { inline_keyboard: [buttons] } };
    };

    const statusMsg = await bot.sendMessage(chatId, `🚀 **Reyd boshlandi!**\nNishon: ${target}\nAkkauntlar: ${clients.length} ta\nProgress: 0/${limit}`, getReydButtons('running'));

    // Nishonni tozalash
    let cleanTarget = String(target).trim();
    if (cleanTarget.startsWith("https://t.me/")) {
        cleanTarget = cleanTarget.replace("https://t.me/", "");
    } else if (cleanTarget.startsWith("t.me/")) {
        cleanTarget = cleanTarget.replace("t.me/", "");
    }
    if (cleanTarget.startsWith("@")) cleanTarget = cleanTarget.substring(1);
    
    // Private link handling (t.me/c/ID/MSG)
    if (cleanTarget.startsWith("c/")) {
        cleanTarget = cleanTarget.split('/')[1];
        if (!cleanTarget.startsWith("-100")) cleanTarget = "-100" + cleanTarget;
    }

    const originalText = (reydMsg.text || reydMsg.caption || "").trim();
    const originalEntities = reydMsg.entities || reydMsg.caption_entities || [];
    const entities = convertToGramJsEntities(originalEntities);

    // Har bir akkaunt uchun nishonni (entity) aniqlab olamiz
    const clientEntities = new Map();
    
    await bot.editMessageText(`🔍 **Nishonni barcha akkauntlarda tasdiqlash...**\nProgress: 0/${clients.length}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
    }).catch(() => {});

    for (let i = 0; i < clients.length; i++) {
        const currentClient = clients[i];
        try {
            let entity;
            if (cleanTarget.includes("+") || cleanTarget.includes("joinchat/")) {
                const hash = cleanTarget.split('/').pop().replace('+', '');
                try {
                    const result = await currentClient.invoke(new Api.messages.ImportChatInvite({ hash }));
                    entity = result.chats ? result.chats[0] : result.chat;
                } catch (err) {
                    if (err.message.includes("USER_ALREADY_PARTICIPANT")) {
                        const check = await currentClient.invoke(new Api.messages.CheckChatInvite({ hash }));
                        entity = check.chat;
                    } else { throw err; }
                }
            } else {
                // Agar target raqam bo'lsa (ID), uni BigInt ga o'tkazamiz
                const maybeId = cleanTarget.replace("-100", "");
                if (/^\d+$/.test(maybeId)) {
                    entity = await currentClient.getInputEntity(cleanTarget);
                } else {
                    entity = await currentClient.getInputEntity(cleanTarget);
                }
            }
            
            if (entity) {
                clientEntities.set(i, entity);
            }
            
            await bot.editMessageText(`🔍 **Nishonni barcha akkauntlarda tasdiqlash...**\nProgress: ${i + 1}/${clients.length}`, {
                chat_id: chatId,
                message_id: statusMsg.message_id
            }).catch(() => {});
        } catch (e) {
            console.error(`[Reyd Auth Error] Akkaunt ${i}:`, e.message);
        }
    }

    if (clientEntities.size === 0) {
        throw new Error("Hech bir akkaunt orqali nishonni topib bo'lmadi. Link yoki username noto'g'ri.");
    }

    let mediaBuffer = null;
    let stickerPath = savedPath;
    let uploadedFile = null;

    try {
        if (reydMsg.sticker && !stickerPath) {
            const tempDir = path.join(process.cwd(), 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
            stickerPath = await bot.downloadFile(reydMsg.sticker.file_id, tempDir);
        } else if (reydMsg.photo) {
            const file = await bot.getFile(reydMsg.photo[reydMsg.photo.length - 1].file_id);
            mediaBuffer = await downloadFile(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
        } else if (reydMsg.video) {
            const file = await bot.getFile(reydMsg.video.file_id);
            mediaBuffer = await downloadFile(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
        }

        // Mediani birinchi akkaunt orqali bir marta yuklab olamiz (optimallashtirish)
        if (clients.length > 0) {
            if (stickerPath) {
                uploadedFile = await clients[0].uploadFile({ file: stickerPath, workers: 1 });
            } else if (mediaBuffer) {
                uploadedFile = await clients[0].uploadFile({ file: mediaBuffer, workers: 1 });
            }
        }
    } catch (err) { console.error("Media yuklash xatosi:", err.message); }

    try {
        let currentClientIndex = 0;

        for (let i = 0; i < limit; i++) {
            while (reydSessions[chatId]?.status === 'paused') {
                await new Promise(r => setTimeout(r, 1000));
            }
            if (!reydSessions[chatId] || reydSessions[chatId].status === 'stopped') break;

            const currentClient = clients[currentClientIndex];
            const entity = clientEntities.get(currentClientIndex);

            if (!entity) {
                currentClientIndex = (currentClientIndex + 1) % clients.length;
                i--;
                continue;
            }

            try {
                if (reydMsg.sticker && stickerPath) {
                    await currentClient.sendFile(entity, {
                        file: uploadedFile || stickerPath,
                        attributes: [new Api.DocumentAttributeSticker({ alt: reydMsg.sticker.emoji || "", stickerset: new Api.InputStickerSetEmpty() })]
                    }).catch(e => { throw e; });
                } else if (reydMsg.photo || reydMsg.video) {
                    await currentClient.sendFile(entity, {
                        file: uploadedFile || mediaBuffer,
                        caption: originalText,
                        formattingEntities: entities
                    }).catch(e => { throw e; });
                } else {
                    const textToSend = originalText || "."; 
                    await currentClient.sendMessage(entity, {
                        message: textToSend,
                        formattingEntities: entities
                    }).catch(e => { throw e; });
                }
                
                reydSessions[chatId].count++;

                // Har bir xabardan keyin akkauntni almashtirish (Rotation)
                currentClientIndex = (currentClientIndex + 1) % clients.length;

                if (reydSessions[chatId].count % 10 === 0 || reydSessions[chatId].count === limit) {
                    await bot.editMessageText(`🚀 **Reyd jarayoni...**\nNishon: ${target}\nProgress: ${reydSessions[chatId].count}/${limit}`, {
                        chat_id: chatId,
                        message_id: statusMsg.message_id,
                        ...getReydButtons(reydSessions[chatId].status)
                    }).catch(() => {});
                }

                // Super tezlik uchun kechikishni 50ms ga tushiramiz (1 sekunda 20 ta xabar nazariy)
                // Lekin bitta akkaunt uchun FloodWait tushmaslik uchun akkauntlar soniga qarab sozlanadi
                const delay = clients.length > 1 ? 50 : 150;
                await new Promise(r => setTimeout(r, delay)); 

            } catch (e) {
                if (e.message.includes("FLOOD_WAIT_")) {
                    const seconds = parseInt(e.message.split("_").pop()) || 10;
                    console.log(`[FloodWait] Akkaunt ${i % clients.length} - ${seconds} soniya kutilmoqda...`);
                    await new Promise(r => setTimeout(r, seconds * 1000));
                    i--;
                    continue;
                } else {
                    console.error(`[Reyd Xatosi] Akkaunt ${i % clients.length}:`, e.message);
                    if (e.message.includes("PEER_FLOOD")) {
                        console.log(`Akkaunt ${i % clients.length} PEER_FLOOD oldi, davom etamiz...`);
                    }
                }
            }
        }
    } catch (criticalErr) {
        console.error("Reyd critical error:", criticalErr.message);
    } finally {
        if (stickerPath && fs.existsSync(stickerPath)) {
            try { fs.unlinkSync(stickerPath); } catch (cleanupErr) {}
        }
        
    if (reydSessions[chatId]?.status === 'stopped' || reydSessions[chatId]?.status === 'finished') {
        const finalStatus = reydSessions[chatId]?.status === 'stopped' ? "to'xtatildi" : "tugadi";
        bot.sendMessage(chatId, `🏁 **Avto Reyd ${finalStatus}!**\nJami yuborildi: ${reydSessions[chatId]?.count || 0} ta.`, getMainMenu(chatId));
        
        const countToAdd = reydSessions[chatId]?.count || 0;
        delete reydSessions[chatId];
        await User.increment({ reydCount: 1 }, { where: { chatId } });
        
        // Barcha vaqtinchalik klientlarni uzish
        for (const key in userClients) {
            if (key.startsWith(`${chatId}_`)) {
                try { await userClients[key].disconnect(); } catch(e) {}
                delete userClients[key];
            }
        }
    }
    }
};

module.exports = {
    startReyd
};

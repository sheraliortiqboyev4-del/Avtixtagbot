/**
 * Utag (Auto Tagging) Service
 * Guruh a'zolarini avtomatik tag qilish
 * (Kodlar originaldan o'zgartirilmasdan ko'chirilgan)
 */

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const config = require("../../config");
const User = require("../../models/User");
const { escapeHTML, upsertUtagHistory, normalizeUtagGroupId, getMainMenu, buildUtagMessage, convertToGramJsEntities } = require('../../utils/helpers');
const { utagStates, PROMO_UTAG } = require('../userbotState');
const { ensureClient } = require('../clientManager');

const DEFAULT_TAG_MESSAGES = [
"Қўшилинг ўйнeли 🦦",
"Қўшилинг топ 1 га алмаз 💎",
"Сзи кутяпмиз 🤨",
"Трикмисз 🧐",
"Жгарим келинг 🫂",
"Келасми ўйинга 👀",
"Қўшилинг тез 👊🏻",
"Балки ўйинга қўшиларсиз 👀",
"Ассалому алайкум 😁",
"Бяхкелингчи 🥱",
"Тезро келинг 😾",
"1 та алмаз бериб туринг 💎",
"Келасми ҳамма кутяпти 🥱" ,
"Сизни махсус чақиряпман 😆",
"Онлайн бўлиб жим туриш – жиноят",
"Рамантика қламизми? 🫣",
"Импортни бомждан салoм 😅",
"Сзам жойнинг",
"Қалесз, кўринмай кетдизку",
"Танидизми ўзи 😎",
"10 та алмаз ташаворин",
"Қўшилмасез тепаман",
"Ўйнамисми бугун ",
"Бот келин",
"Мен сени кўряпман 👀",
"Нима гап",
"Гап йўқми сизда 💬",
"Шунақа жим юраверасизми",
"Алмазли ўйин келин",
"Қани сиз",
"Сзи кутиб зерикдим",
"Қўшилинг бошлаймиз",
"Қочиб кетманг 😂",
"Ёзиб туринг",
"Сизни кутяпмиз 💥",
"Жим турманг",
"Ёзинг",
"Жонкам келинг 😂",
"Қўшиласми",
"Сзи соғиндик",
"Тезз ке"
];

const normalizeTelegramGroupId = (linkOrId) => {
    const s = String(linkOrId).trim();
    if (!s) return s;
    if (s.startsWith('@') || s.includes('t.me/') || s.includes('joinchat')) return s;
    if (/^-100\d+$/.test(s)) return s;
    if (/^-\d+$/.test(s)) return s;
    if (/^\d+$/.test(s)) return `-100${s}`;
    return s;
};

const isUtagGroupEntity = (entity) => {
    if (!entity) return false;
    const cn = entity.className || entity.constructor?.name || '';
    return cn === 'Channel' || cn === 'Chat' || entity.megagroup || entity.broadcast !== undefined;
};

const cacheUtagParticipant = async (client, participant) => {
    if (!participant || participant.username) return true;
    const userId = BigInt(participant.id);
    const accessHash = participant.accessHash != null ? BigInt(participant.accessHash) : null;
    try {
        if (accessHash != null) {
            await client.getInputEntity(new Api.InputPeerUser({ userId, accessHash }));
        } else {
            await client.getInputEntity(participant);
        }
        return true;
    } catch (e) {
        console.error(`[UTag] User ${participant.id} cache xato:`, e.message);
        return false;
    }
};

const sendUtagToParticipant = async (client, groupEntity, participant, extraText, opts = {}, fallbackClient = null) => {
    if (participant.bot || participant.deleted) return false;
    const { useEmojiMap = false, customEntities = null } = opts;

    const send = async (activeClient) => {
        // Username bor — oddiy @mention
        if (participant.username) {
            const mentionText = `@${participant.username}`;
            const { cleanText, entities } = buildUtagMessage(mentionText, extraText, { useEmojiMap, customEntities });
            const tgEntities = convertToGramJsEntities(entities);
            await activeClient.sendMessage(groupEntity, {
                message: cleanText,
                formattingEntities: tgEntities && tgEntities.length ? tgEntities : undefined
            });
            return;
        }

        // Username yo'q — text_mention bilan bosiladigan ism
        await cacheUtagParticipant(activeClient, participant).catch(() => {});
        const name = participant.firstName || 'Foydalanuvchi';
        const userId = participant.id?.toString?.() || String(participant.id);
        const accessHash = participant.accessHash != null ? participant.accessHash.toString() : null;

        const { cleanText, entities } = buildUtagMessage(name, extraText, {
            mentionUser: { id: userId, accessHash },
            useEmojiMap,
            customEntities
        });
        const tgEntities = convertToGramJsEntities(entities);
        await activeClient.sendMessage(groupEntity, {
            message: cleanText,
            formattingEntities: tgEntities && tgEntities.length ? tgEntities : undefined
        });
    };

    try {
        await send(client);
        return true;
    } catch (e) {
        if (fallbackClient && fallbackClient !== client) {
            try {
                await send(fallbackClient);
                return true;
            } catch (e2) {
                console.error(`[UTag] Fallback ham xato (User: ${participant.id}):`, e2.message);
            }
        }
        throw e;
    }
};

const fetchUtagParticipants = async (client, entity, memberFilter, limit) => {
    const cap = limit > 0 ? limit : undefined;
    let participants = [];

    if (memberFilter === 'online') {
        try {
            participants = await client.getParticipants(entity, {
                filter: new Api.ChannelParticipantsOnline({}),
                limit: cap
            });
        } catch (e) {
            console.error('[UTag] Online filter xato, fallback:', e.message);
            const all = await client.getParticipants(entity, { limit: cap ? cap * 3 : 500 });
            participants = all.filter((p) => {
                const st = p.status;
                return st && (
                    st instanceof Api.UserStatusOnline ||
                    st instanceof Api.UserStatusRecently ||
                    st instanceof Api.UserStatusLastMonth
                );
            });
            if (cap) participants = participants.slice(0, cap);
        }
    } else {
        participants = await client.getParticipants(entity, { limit: cap });
    }
    return participants;
};

const startAutoTag = async (chatId, groupLink, bot, opts = {}) => {
    const {
        limit = 0,
        tagText = null,
        tagEntities = null,
        mode = 'only_mention',
        memberFilter = 'all',
        isCommand = false,
        groupTitle: presetTitle = null
    } = opts;
    const user = await User.findOne({ where: { chatId } });
    if (!user) throw new Error("Foydalanuvchi topilmadi.");

    // Akkauntlarni tayyorlash
    let sessions = [];
    let clients = [];
    let mainClient; // Declare mainClient here to use everywhere!

    if (user.utagAccountMode === 'main') {
        // Asosiy akkaunt rejimi — faqat asosiyni ishlatamiz
        sessions = [user.session];
        mainClient = await ensureClient(chatId, bot);
        clients.push(mainClient);
    } else if (user.utagAccountMode === 'all') {
        // Barcha akkauntlar rejimi — faqat qo'shimcha akkauntlarni ishlatamiz!
        const rekAccs = (user.reklamaAccounts || []).map(acc => acc.session);
        if (rekAccs.length === 0) {
            // Qo'shimcha akkaunt yo'q bo'lsa xabar beramiz
            await bot.sendMessage(chatId, "❌ Sizda hech qanday qo'shimcha akkaunt ulanmagan! Iltimos, akkaunt qo'shish uchun botda kerakli bo'limdan foydalaning.");
            return;
        }
        sessions = rekAccs;
        // Also get mainClient for fetching entity/participants (we need it!)
        mainClient = await ensureClient(chatId, bot);

        // Faqat qo'shimcha akkauntlarni ulaymiz!
        for (let i = 0; i < sessions.length; i++) {
            try {
                const tempClient = new TelegramClient(new StringSession(sessions[i]), config.apiId, config.apiHash, {
                    connectionRetries: 5,
                    requestRetries: 2,
                    timeout: 30000,
                    autoReconnect: true,
                    floodSleepThreshold: 300,
                    useWSS: false,
                    proxy: undefined
                });
                await tempClient.connect();
                if (await tempClient.checkAuthorization()) {
                    // Muhim: Entity cache ni to'ldirish uchun dialoglarni olamiz
                    await tempClient.getDialogs({ limit: 50 }).catch(() => {});
                    clients.push(tempClient);
                }
            } catch (e) {
                console.error(`[UTag] Akkaunt ${i + 1} (qo'shimcha) ulanishda xato:`, e.message);
            }
        }

        // Agar hech qanday qo'shimcha akkaunt ulana olmasak xabar beramiz
        if (clients.length === 0) {
            await bot.sendMessage(chatId, "❌ Hech qanday qo'shimcha akkaunt ulana olmadi! Iltimos, akkauntlaringizni tekshiring.");
            return;
        }
    }

    try {
        let entity;
        const rawLink = String(groupLink).trim();
        const peer = normalizeTelegramGroupId(rawLink);

        if (typeof peer === 'string' && (peer.includes("t.me/+") || peer.includes("joinchat/"))) {
            const hash = peer.split('/').pop().replace('+', '');
            try {
                const result = await mainClient.invoke(new Api.messages.ImportChatInvite({ hash }));
                entity = result.chats ? result.chats[0] : result.chat;
            } catch (err) {
                if (err.message.includes("USER_ALREADY_PARTICIPANT")) {
                    const check = await mainClient.invoke(new Api.messages.CheckChatInvite({ hash }));
                    entity = check.chat;
                } else { throw err; }
            }
        } else {
            entity = await mainClient.getEntity(peer);
        }

        if (!isUtagGroupEntity(entity)) {
            throw new Error("Bu guruh/kanal emas. Guruhni qayta tanlang.");
        }

        for (let i = 0; i < clients.length; i++) {
            try { await clients[i].getEntity(entity).catch(() => {}); } catch (e) {}
        }

        const participants = await fetchUtagParticipants(mainClient, entity, memberFilter, parseInt(limit, 10) || 0);

        // Multi-client warm-up: har bir qo'shimcha clientni getParticipants orqali
        // accessHash bilan to'ldiramiz, shunda text_mention link'lari ishlaydi
        if (clients.length > 1) {
            for (let i = 1; i < clients.length; i++) {
                try {
                    await fetchUtagParticipants(clients[i], entity, memberFilter, parseInt(limit, 10) || 0);
                } catch (e) {
                    console.error(`[UTag] Akkaunt #${i + 1} cache xato:`, e.message);
                }
            }
        }

        const groupId = normalizeUtagGroupId(entity.id?.toString() || groupLink);
        const groupTitle = presetTitle || entity.title || entity.username || "Guruh";
        const historyLink = /^-?\d+$/.test(String(groupLink).trim())
            ? groupId
            : (entity.username ? `@${entity.username}` : String(groupLink).trim());

        const history = upsertUtagHistory(user.utagHistory, {
            id: groupId,
            title: groupTitle,
            link: historyLink,
            mode,
            limit: parseInt(limit, 10) || 0,
            tagText: mode === 'custom' ? tagText : null,
            tagEntities: mode === 'custom' ? tagEntities : null,
            memberFilter
        });
        await User.update({ utagHistory: history }, { where: { chatId } });

        let count = 0;
        utagStates[chatId] = { status: 'running', count: 0, total: participants.length };

        const shuffledMessages = [...DEFAULT_TAG_MESSAGES].sort(() => Math.random() - 0.5);

        const getUtagButtons = (status) => {
            const buttons = [];
            if (status === 'running') buttons.push({ text: "⏸ Pauza", callback_data: "utag_pause" });
            if (status === 'paused') buttons.push({ text: "▶️ Davom etish", callback_data: "utag_resume" });
            buttons.push({ text: "⏹ To'xtatish", callback_data: "utag_stop" });
            return { reply_markup: { inline_keyboard: [buttons] } };
        };

        const modeText = mode === 'custom' ? `Matn: "${tagText}"` : (mode === 'only_mention' ? "Faqat @" : "Bot so'zlari");
        const filterText = memberFilter === 'online' ? 'Faqat online' : (limit > 0 ? `${limit} ta odam` : 'Hammani');
        const accText = user.utagAccountMode === 'all' ? `Barcha akkauntlar (${clients.length} ta)` : "Faqat asosiy akkaunt";
        const startText = `🚀 **Utag boshlandi**\nTo'xtatish: /s\n\nGuruh: ${groupTitle}\nTag: ${filterText}\nRejim: ${modeText}\nJami: ${participants.length} ta\nAkkaunt: ${accText}`;
        
        const statusMsg = await bot.sendMessage(chatId, startText, isCommand ? {} : getUtagButtons('running')).catch(() => null);

        let currentClientIndex = 0;

        for (const p of participants) {
            while (utagStates[chatId]?.status === 'paused') {
                await new Promise(r => setTimeout(r, 1000));
            }
            if (!utagStates[chatId] || utagStates[chatId].status === 'stopped') break;

            const currentClient = clients[currentClientIndex];
            
            try {
                const tagNumber = count + 1;
                let extraText = '';
                const sendOpts = {};

                if (mode === 'random_words') {
                    extraText = ' ' + (shuffledMessages[count % shuffledMessages.length] || "");
                    sendOpts.useEmojiMap = true; // bot so'zlari uchun premium emoji
                } else if (mode === 'custom' && tagText) {
                    extraText = ' ' + tagText;
                    if (tagEntities && tagEntities.length > 0) {
                        sendOpts.customEntities = tagEntities;
                    }
                }
                // only_mention rejimida hech narsa qo'shilmaydi — faqat @username

                if (tagNumber % 10 === 0) {
                    extraText += ` ${PROMO_UTAG()}`;
                }

                await sendUtagToParticipant(currentClient, entity, p, extraText, sendOpts, mainClient);

                count++;
                utagStates[chatId].count = count;
                
                // Navbatdagi clientga o'tamiz (har 2 ta xabardan keyin rotatsiya)
                if (count % 2 === 0) {
                    currentClientIndex = (currentClientIndex + 1) % clients.length;
                }

                if (statusMsg && (count % 5 === 0 || count === participants.length)) {
                    const buttons = isCommand ? {} : getUtagButtons(utagStates[chatId].status);
                    await bot.editMessageText(`🚀 **Uteg jarayoni...**\nProgress: ${count}/${participants.length}`, {
                        chat_id: chatId,
                        message_id: statusMsg.message_id,
                        ...buttons
                    }).catch(() => {});
                }

                // Delay: Akkauntlar ko'p bo'lsa tezroq, kam bo'lsa sekinroq
                const delay = clients.length > 1 ? 500 : 1000;
                await new Promise(r => setTimeout(r, delay)); 
            } catch (e) {
                if (e.message.includes("FLOOD_WAIT")) {
                    const waitTime = parseInt(e.message.match(/\d+/)[0]);
                    // Agar bu akkaunt flood bo'lsa, uni vaqtincha tashlab ketamiz
                    if (clients.length > 1) {
                        clients.splice(currentClientIndex, 1);
                        if (clients.length === 0) break; // Hech qaysi akkaunt qolmasa to'xtatamiz
                        currentClientIndex = currentClientIndex % clients.length;
                    } else {
                        await new Promise(r => setTimeout(r, waitTime * 1000));
                    }
                } else {
                    console.error(`Tag xatosi (User: ${p.id}):`, e.message);
                    // Keyingi clientga o'tib urinib ko'ramiz
                    currentClientIndex = (currentClientIndex + 1) % clients.length;
                }
            }
        }
        
        const wasStopped = utagStates[chatId]?.status === 'stopped';
        const finalLabel = wasStopped ? "To'xtatildi" : "Tugadi";

        // 1) Status xabarini tahrirlab, natijani ko'rsatamiz (tugmalarni olib tashlaymiz)
        if (statusMsg && statusMsg.message_id) {
            await bot.editMessageText(
                `🏁 **Uteg jarayoni ${finalLabel}!**\nGuruh: ${groupTitle}\nJami tag qilindi: ${count}/${participants.length} ta.`,
                {
                    chat_id: chatId,
                    message_id: statusMsg.message_id
                }
            ).catch(() => {});
        } else {
            // statusMsg bo'lmasa (masalan /t buyruq orqali) — oddiy xabar
            await bot.sendMessage(chatId, `🏁 **Uteg jarayoni ${finalLabel}!**\nJami tag qilindi: ${count} ta.`).catch(() => {});
        }

        // 2) Asosiy menyuni alohida xabarda chiqaramiz (faqat bot orqali ishga tushgan bo'lsa)
        if (!isCommand) {
            await bot.sendMessage(chatId, "📊 **Asosiy menyu:**", getMainMenu(chatId)).catch(() => {});
        }

        await User.increment({ utagCount: 1 }, { where: { chatId } });
        delete utagStates[chatId];
    } catch (e) {
        throw new Error(`Uteg xatosi: ${e.message}`);
    } finally {
        // Qo'shimcha clientlarni uzish (asosiy clientdan tashqari)
        for (let i = 1; i < clients.length; i++) {
            try { await clients[i].disconnect(); } catch (e) {}
        }
    }
};

module.exports = {
    startAutoTag,
    DEFAULT_TAG_MESSAGES
};

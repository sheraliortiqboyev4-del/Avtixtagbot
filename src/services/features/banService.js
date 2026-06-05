/**
 * Avto Ban Service
 * Guruh/kanal a'zolarini avtomatik ban (superguruh/kanal) yoki kick (oddiy guruh).
 * Mavjud logikaga ta'sir qilmaydi — alohida modul.
 */

const { Api } = require("telegram");
const { getMainMenu } = require('../../utils/helpers');
const { banSessions } = require('../userbotState');
const { ensureClient } = require('../clientManager');

// Tezlik rejimlari (har banlash orasidagi kechikish, ms)
const BAN_SPEEDS = {
    slow: { label: "🐢 Sekin (xavfsiz)", delay: 2500 },
    normal: { label: "⚡ O'rtacha", delay: 1200 },
    fast: { label: "🚀 Tez (xavfli)", delay: 500 }
};

/** Guruh linkidan entity olish (link, @username, ID, invite). */
async function resolveGroupEntity(client, groupLink) {
    const rawLink = String(groupLink).trim();

    if (/^-?\d+$/.test(rawLink)) {
        return await client.getEntity(BigInt(rawLink));
    }
    if (rawLink.includes("t.me/+") || rawLink.includes("joinchat/")) {
        const hash = rawLink.split('/').pop().replace('+', '');
        try {
            const result = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
            return result.chats ? result.chats[0] : result.chat;
        } catch (err) {
            if (err.message.includes("USER_ALREADY_PARTICIPANT")) {
                const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                return check.chat;
            }
            throw err;
        }
    }
    return await client.getEntity(rawLink);
}

/** Entity superguruh/kanalmi (channel) yoki oddiy guruhmi (chat). */
function isChannelEntity(entity) {
    const cn = entity?.className || entity?.constructor?.name || '';
    return cn === 'Channel' || entity?.megagroup === true || entity?.broadcast === true;
}

/** Akkaunt shu guruhda admin va ban/kick huquqi bormi — tekshiradi. */
async function checkBanRights(client, entity, isChannel) {
    try {
        if (isChannel) {
            const me = await client.getMe();
            const res = await client.invoke(new Api.channels.GetParticipant({
                channel: entity,
                participant: me.id
            }));
            const p = res.participant;
            const cn = p?.className || p?.constructor?.name || '';
            if (cn === 'ChannelParticipantCreator') {
                return { ok: true, reason: 'creator' };
            }
            if (cn === 'ChannelParticipantAdmin') {
                const rights = p.adminRights;
                if (rights && rights.banUsers) return { ok: true, reason: 'admin' };
                return { ok: false, reason: "Akkauntda 'Ban users' huquqi yo'q." };
            }
            return { ok: false, reason: "Akkaunt bu guruhda admin emas." };
        }
        // Oddiy guruh (basic chat) — kick uchun admin bo'lishi kerak
        return { ok: true, reason: 'basic' };
    } catch (e) {
        return { ok: false, reason: `Huquqni tekshirib bo'lmadi: ${e.message}` };
    }
}

/** A'zolarni filtr bo'yicha olish (hammasi / online / N ta). */
async function fetchBanTargets(client, entity, filter, limit) {
    const cap = limit > 0 ? limit : undefined;
    let participants = [];

    if (filter === 'online') {
        try {
            participants = await client.getParticipants(entity, {
                filter: new Api.ChannelParticipantsOnline({}),
                limit: cap
            });
        } catch (e) {
            const all = await client.getParticipants(entity, { limit: cap ? cap * 3 : 1000 });
            participants = all.filter((p) => {
                const st = p.status;
                return st && (
                    st instanceof Api.UserStatusOnline ||
                    st instanceof Api.UserStatusRecently
                );
            });
            if (cap) participants = participants.slice(0, cap);
        }
    } else {
        participants = await client.getParticipants(entity, { limit: cap });
    }
    return participants;
}

/**
 * Banlashdan oldin tayyorlash: entity, tur, huquq, a'zolar soni.
 * Tasdiqlash xabari uchun ma'lumot qaytaradi.
 */
async function prepareBan(chatId, groupLink, filter, limit, bot) {
    const client = await ensureClient(chatId, bot);

    const entity = await resolveGroupEntity(client, groupLink);
    if (!entity) throw new Error("Guruh topilmadi. Link yoki username noto'g'ri.");

    const isChannel = isChannelEntity(entity);

    const rights = await checkBanRights(client, entity, isChannel);
    if (!rights.ok) {
        throw new Error(rights.reason);
    }

    const targets = await fetchBanTargets(client, entity, filter, limit);
    const me = await client.getMe();
    const myId = me.id.toString();

    // O'zini va botlarni/o'chirilganlarni chiqarib tashlaymiz
    const filtered = targets.filter(
        (p) => p && p.id && p.id.toString() !== myId && !p.bot && !p.deleted
    );

    return {
        title: entity.title || entity.username || "Guruh",
        isChannel,
        total: filtered.length,
        actionLabel: isChannel ? "ban" : "chiqarish"
    };
}

/** Bitta userni ban (channel) yoki kick (basic chat) qilish. */
async function banOne(client, entity, participant, isChannel) {
    if (isChannel) {
        await client.invoke(new Api.channels.EditBanned({
            channel: entity,
            participant: participant,
            bannedRights: new Api.ChatBannedRights({
                untilDate: 0, // doimiy
                viewMessages: true,
                sendMessages: true,
                sendMedia: true,
                sendStickers: true,
                sendGifs: true,
                sendGames: true,
                sendInline: true,
                embedLinks: true
            })
        }));
    } else {
        // Oddiy guruh — faqat chiqarish (kick)
        await client.invoke(new Api.messages.DeleteChatUser({
            chatId: entity.id,
            userId: participant
        }));
    }
}

const getBanButtons = (status) => {
    const buttons = [];
    if (status === 'running') buttons.push({ text: "⏸ Pauza", callback_data: "ban_pause" });
    if (status === 'paused') buttons.push({ text: "▶️ Davom etish", callback_data: "ban_resume" });
    buttons.push({ text: "⏹ To'xtatish", callback_data: "ban_stop" });
    return { reply_markup: { inline_keyboard: [buttons] } };
};

/**
 * Banlashni boshlash. Real-time log ko'rsatadi, pause/stop qo'llab-quvvatlaydi.
 */
async function startBan(chatId, groupLink, filter, limit, speed, bot) {
    if (banSessions[chatId] && banSessions[chatId].status !== 'stopped') {
        throw new Error("Avto Ban allaqachon ishga tushirilgan.");
    }

    const delay = (BAN_SPEEDS[speed] || BAN_SPEEDS.normal).delay;
    const client = await ensureClient(chatId, bot);

    const entity = await resolveGroupEntity(client, groupLink);
    if (!entity) throw new Error("Guruh topilmadi.");
    const isChannel = isChannelEntity(entity);

    const rights = await checkBanRights(client, entity, isChannel);
    if (!rights.ok) throw new Error(rights.reason);

    const targets = await fetchBanTargets(client, entity, filter, limit);
    const me = await client.getMe();
    const myId = me.id.toString();
    const list = targets.filter(
        (p) => p && p.id && p.id.toString() !== myId && !p.bot && !p.deleted
    );

    if (list.length === 0) throw new Error("Ban qilinadigan a'zolar topilmadi.");

    const actionVerb = isChannel ? "banlandi" : "chiqarildi";
    banSessions[chatId] = { status: 'running', count: 0, total: list.length, failed: 0 };

    const title = entity.title || entity.username || "Guruh";
    const statusMsg = await bot.sendMessage(
        chatId,
        `🚫 **Avto Ban boshlandi!**\n\nGuruh: ${title}\nJami: ${list.length} ta\nProgress: 0/${list.length}`,
        getBanButtons('running')
    );

    const updateStatus = async (extra = '') => {
        const s = banSessions[chatId];
        if (!s || !statusMsg) return;
        let text = `🚫 **Avto Ban jarayoni...**\n\n`;
        text += `📍 Guruh: ${title}\n`;
        text += `✅ ${actionVerb}: ${s.count}/${s.total}\n`;
        if (s.failed > 0) text += `⚠️ Xato: ${s.failed} ta\n`;
        if (extra) text += `\n${extra}`;
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            ...getBanButtons(s.status)
        }).catch(() => {});
    };

    try {
        for (const p of list) {
            // Pauza
            while (banSessions[chatId]?.status === 'paused') {
                await new Promise(r => setTimeout(r, 1000));
            }
            if (!banSessions[chatId] || banSessions[chatId].status === 'stopped') break;

            try {
                await banOne(client, entity, p, isChannel);
                banSessions[chatId].count++;
            } catch (e) {
                const msg = e.message || '';
                if (msg.includes("FLOOD_WAIT")) {
                    const seconds = parseInt(msg.split("_").pop()) || 10;
                    for (let i = seconds; i > 0; i--) {
                        if (!banSessions[chatId] || banSessions[chatId].status === 'stopped') break;
                        await updateStatus(`⏳ FLOOD: ${i} soniya kutilmoqda...`);
                        await new Promise(r => setTimeout(r, 1000));
                    }
                    // Shu userni qayta urinamiz
                    try {
                        await banOne(client, entity, p, isChannel);
                        banSessions[chatId].count++;
                    } catch (e2) {
                        banSessions[chatId].failed++;
                    }
                } else if (
                    msg.includes("USER_ADMIN_INVALID") ||
                    msg.includes("CHAT_ADMIN_REQUIRED") ||
                    msg.includes("USER_NOT_PARTICIPANT") ||
                    msg.includes("PARTICIPANT_ID_INVALID")
                ) {
                    // Admin/egasini yoki guruhda yo'q userni banlab bo'lmaydi — o'tkazib yuboramiz
                    banSessions[chatId].failed++;
                } else {
                    banSessions[chatId].failed++;
                    console.error(`[Ban] Xato (${p.id}):`, msg);
                }
            }

            if (banSessions[chatId].count % 5 === 0) {
                await updateStatus();
            }
            await new Promise(r => setTimeout(r, delay));
        }
    } finally {
        const s = banSessions[chatId];
        const wasStopped = s?.status === 'stopped';
        const finalLabel = wasStopped ? "to'xtatildi" : "tugadi";
        const done = s?.count || 0;
        const failed = s?.failed || 0;

        if (statusMsg && statusMsg.message_id) {
            await bot.editMessageText(
                `🏁 **Avto Ban ${finalLabel}!**\n\nGuruh: ${title}\n✅ ${actionVerb}: ${done} ta\n⚠️ O'tkazib yuborildi: ${failed} ta`,
                { chat_id: chatId, message_id: statusMsg.message_id }
            ).catch(() => {});
        }
        await bot.sendMessage(chatId, "📊 **Asosiy menyu:**", getMainMenu(chatId)).catch(() => {});
        delete banSessions[chatId];
    }
}

module.exports = {
    BAN_SPEEDS,
    resolveGroupEntity,
    isChannelEntity,
    checkBanRights,
    fetchBanTargets,
    prepareBan,
    startBan
};

/**
 * Scraping Service
 * Guruhdan user yig'ish (Active / Mention)
 * (Kodlar originaldan o'zgartirilmasdan ko'chirilgan)
 */

const { Api } = require("telegram");
const User = require("../../models/User");
const { getMainMenu } = require('../../utils/helpers');
const { scrapeSessions } = require('../userbotState');
const { ensureClient } = require('../clientManager');

const scrapeUsers = async (chatId, groupLink, limit = 1000, bot) => {
    const client = await ensureClient(chatId, bot);
    const me = await client.getMe();
    const myId = me.id;
    
    try {
        let entity;
        const rawLink = String(groupLink).trim();
        // 1. Guruhga ulanish (link, @username yoki chat_shared ID)
        if (/^-?\d+$/.test(rawLink)) {
            entity = await client.getEntity(BigInt(rawLink));
        } else if (rawLink.includes("t.me/+") || rawLink.includes("joinchat/")) {
            const hash = rawLink.split('/').pop().replace('+', '');
            try {
                const result = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
                entity = result.chats ? result.chats[0] : result.chat;
            } catch (err) {
                if (err.message.includes("USER_ALREADY_PARTICIPANT")) {
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    entity = check.chat;
                } else { throw err; }
            }
        } else {
            try {
                entity = await client.getEntity(rawLink);
                await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
            } catch (err) {
                if (!err.message.includes("USER_ALREADY_PARTICIPANT")) {
                    entity = await client.getEntity(rawLink);
                }
            }
        }

        if (!entity) throw new Error("Guruh topilmadi.");

        // Initialize session
        scrapeSessions[chatId] = {
            status: 'running',
            type: 'active',
            gatheredUserIds: new Set(),
            members: [],
            adminCount: 0,
            memberCount: 0,
            scannedMessages: 0,
            entity: null,
            client: null,
            statusMsg: null
        };

        const statusMsg = await bot.sendMessage(chatId, "⏳ **Userlarni yig'ish boshlandi...**\nIltimos, jarayon tugashini kuting.", { 
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⏹ To'xtatish", callback_data: "scrape_stop" }]
                ]
            }
        });
        scrapeSessions[chatId].statusMsg = statusMsg;
        
        // Pin the status message
        await bot.pinChatMessage(chatId, statusMsg.message_id, { disable_notification: true }).catch(err => console.error("Pin error:", err.message));

        const gatheredUserIds = new Set();
        const members = [];
        let adminCount = 0; // Adminlar soni
        let adminParts = 1; // Adminlar qismlari soni
        let memberCount = 0; // A'zolar soni
        let memberParts = 1; // A'zolar qismlari soni
        let scannedMessages = 0;

        // Function to update status message
        const updateStatus = async (extra = '') => {
            if (!scrapeSessions[chatId] || scrapeSessions[chatId].status === 'stopped') return;
            const session = scrapeSessions[chatId];
            if (!session.statusMsg) return;
            
            let text = `⏳ **Userlarni yig'ish jarayoni...**\n\n`;
            text += `📊 O'qilgan xabarlar: ${scannedMessages}\n`;
            text += `👑 Adminlar: ${adminCount} ta\n`;
            text += `👥 A'zolar: ${memberCount} ta\n`;
            text += `📊 Jami: ${gatheredUserIds.size} ta`;
            if (extra) {
                text += `\n\n⚠️ ${extra}`;
            }
            try {
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: session.statusMsg.message_id,
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "⏹ To'xtatish", callback_data: "scrape_stop" }]
                        ]
                    }
                });
            } catch (e) {
                if (!e.message.includes("message is not modified")) {
                    console.error("Status update error:", e.message);
                }
            }
        };

        // 2. Adminlarni yig'ish
        try {
            const adminParticipants = await client.getParticipants(entity, {
                filter: new Api.ChannelParticipantsAdmins()
            });

            const currentAdmins = [];
            for (const p of adminParticipants) {
                if (p.bot || !p.username || p.deleted || p.id.toString() === myId.toString()) continue;
                if (!gatheredUserIds.has(p.id.toString())) {
                    currentAdmins.push({ id: p.id.toString(), username: p.username });
                    gatheredUserIds.add(p.id.toString());
                    adminCount++; // Adminlar sonini oshirish
                    
                    // Update status every time we add a user
                    if (adminCount % 10 === 0) {
                        await updateStatus();
                    }
                    
                    // Har 100 ta yig'ilganda yuborish
                    if (currentAdmins.length >= 100) {
                        let text = `👑 **Adminlar:** ( ${adminCount} ta, ${adminParts} qism ) \n\n`;
                        text += currentAdmins.map(a => `@${a.username}`).join("\n");
                        await bot.sendMessage(chatId, text).catch(() => {});
                        currentAdmins.length = 0;
                        adminParts++; // Qism sonini oshirish
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            }
            // Qolgan adminlarni yuborish
            if (currentAdmins.length > 0) {
                let text = `👑 **Adminlar:** ( ${adminCount} ta, ${adminParts} qism )\n\n`;
                text += currentAdmins.map(a => `@${a.username}`).join("\n");
                await bot.sendMessage(chatId, text).catch(() => {});
                adminParts++; // Qism sonini oshirish
            }
        } catch (e) {
            console.error("Adminlarni yig'ishda xato:", e.message);
        }

        // 3. Tarixdan qidirish (History Scan) - faqat bu ishlaydi, admin huquqi yo'q bo'lsa
        let scanLimit = 3000000;
        let messageIterator = client.iterMessages(entity, { limit: scanLimit });
        
        try {
            for await (const message of messageIterator) {
                // Check if stopped
                if (scrapeSessions[chatId] && scrapeSessions[chatId].status === 'stopped') {
                    break;
                }
                
                if (gatheredUserIds.size >= limit) break;
                scannedMessages++;

                const sender = message.sender;
                // SENDER mavjudligini va u USER ekanligini tekshiramiz
                if (sender && sender instanceof Api.User && !sender.bot && sender.username && !sender.deleted && sender.id.toString() !== myId.toString()) {
                    const senderIdStr = sender.id.toString();
                    if (!gatheredUserIds.has(senderIdStr)) {
                        members.push({ id: senderIdStr, username: sender.username });
                        gatheredUserIds.add(senderIdStr);
                        memberCount++; // A'zolar sonini oshirish

                        // Update status every 50 messages or when a user is added
                        if (scannedMessages % 50 === 0 || memberCount % 10 === 0) {
                            await updateStatus();
                        }

                        // Har 100 ta yig'ilganda darhol yuborish
                        if (members.length >= 100) {
                            let text = `👥 **Azolar:** ( ${memberCount} ta, ${memberParts} qism )\n\n`;
                            text += members.map(m => `@${m.username}`).join("\n");
                            await bot.sendMessage(chatId, text).catch(e => console.error("Batch send error:", e.message));
                            members.length = 0; // Massivni tozalash
                            memberParts++; // Qism sonini oshirish
                            await new Promise(r => setTimeout(r, 2000)); // Flood protection
                        }
                    }
                }
                
                // Har 500 ta xabardan keyin kichik tanaffus (Flood protection)
                if (scannedMessages % 500 === 0) {
                    await updateStatus();
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        } catch (e) {
            console.error("History scan xatosi:", e.message);
            if (e.message.includes("FLOOD_WAIT")) {
                const seconds = parseInt(e.message.split("_").pop()) || 10;
                
                // Show flood wait countdown
                for (let i = seconds; i > 0; i--) {
                    if (scrapeSessions[chatId] && scrapeSessions[chatId].status === 'stopped') break;
                    await updateStatus(`FLOOD -- ${i} sekund`);
                    await new Promise(r => setTimeout(r, 1000));
                }
                
                // If not stopped, continue
                if (scrapeSessions[chatId] && scrapeSessions[chatId].status !== 'stopped') {
                    await updateStatus();
                }
            }
        }

        // 5. Yakuniy natija
        const summaryText = `🏁 **NATIJA:**\n\n` +
            `👑 **Adminlar:** ${adminCount} ta, ${adminParts} qism\n` +
            `👥 **A'zolar:** ${memberCount} ta, ${memberParts} qism\n` +
            `📊 **Jami:** ${gatheredUserIds.size} ta`;
        
        // Save status message reference FIRST before deleting session
        const session = scrapeSessions[chatId];
        const statusMessageObj = session?.statusMsg || statusMsg;
        
        // Try to edit status message to show it's finished
        if (statusMessageObj && statusMessageObj.message_id) {
            try {
                await bot.editMessageText("✅ Jarayon tugadi!", {
                    chat_id: chatId,
                    message_id: statusMessageObj.message_id,
                    parse_mode: "Markdown"
                });
            } catch (e) {
                // Ignore edit errors
            }
            
            // Unpin the message
            await bot.unpinChatMessage({ chat_id: chatId, message_id: statusMessageObj.message_id }).catch(err => console.error("Unpin error:", err.message));
            
            // Delete the status message
            await bot.deleteMessage({ chat_id: chatId, message_id: statusMessageObj.message_id }).catch(() => {});
        }
        
        // Cleanup session LAST
        if (scrapeSessions[chatId]) {
            delete scrapeSessions[chatId];
        }
        
        // Qolgan a'zolarni yuborish (agar 100 taga yetmagan bo'lsa)
        if (members.length > 0) {
            let text = `👥 **Azolar:** ( ${memberCount} ta, ${memberParts} qism )\n\n`;
            text += members.map(m => `@${m.username}`).join("\n");
            await bot.sendMessage(chatId, text).catch(e => console.error("Final batch send error:", e.message));
            memberParts++; // Qism sonini oshirish
        }

        // 3. Yakuniy xulosa (ALOIDA)
        await bot.sendMessage(chatId, summaryText, { 
            parse_mode: "Markdown"
        });
        
        // 4. Asosiy menyu (ALOIDA)
        await bot.sendMessage(chatId, "📊 **Asosiy menyu:**", getMainMenu(chatId));

        // Bazani yangilash
        await User.increment({ usersGathered: gatheredUserIds.size }, { where: { chatId } });

        return true;
    } catch (error) { 
        console.error("Scrape error:", error);
        throw error; 
    }
};

const scrapeMentionUsers = async (chatId, groupLink, historyLimit = 1000000, bot) => {
    const client = await ensureClient(chatId, bot);
    const me = await client.getMe();
    const myId = me.id;
    
    try {
        let entity;
        const rawLink = String(groupLink).trim();
        // 1. Guruhga ulanish (link, @username yoki chat_shared ID)
        if (/^-?\d+$/.test(rawLink)) {
            entity = await client.getEntity(BigInt(rawLink));
        } else if (rawLink.includes("t.me/+") || rawLink.includes("joinchat/")) {
            const hash = rawLink.split('/').pop().replace('+', '');
            try {
                const result = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
                entity = result.chats ? result.chats[0] : result.chat;
            } catch (err) {
                if (err.message.includes("USER_ALREADY_PARTICIPANT")) {
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    entity = check.chat;
                } else { throw err; }
            }
        } else {
            try {
                entity = await client.getEntity(rawLink);
                await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
            } catch (err) {
                if (!err.message.includes("USER_ALREADY_PARTICIPANT")) {
                    entity = await client.getEntity(rawLink);
                }
            }
        }

        if (!entity) throw new Error("Guruh topilmadi.");

        // Initialize session
        scrapeSessions[chatId] = {
            status: 'running',
            type: 'mention',
            gatheredUserIds: new Set(),
            members: [],
            memberCount: 0,
            scannedMessages: 0,
            entity: null,
            client: null,
            statusMsg: null
        };

        const statusMsg = await bot.sendMessage(chatId, "⏳ **Mention azolarni yig'ish boshlandi...**\nIltimos, jarayon tugashini kuting.", { 
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⏹ To'xtatish", callback_data: "scrape_stop" }]
                ]
            }
        });
        scrapeSessions[chatId].statusMsg = statusMsg;
        
        // Pin the status message
        await bot.pinChatMessage(chatId, statusMsg.message_id, { disable_notification: true }).catch(err => console.error("Pin error:", err.message));

        const gatheredUserIds = new Set();
        const members = [];
        let memberCount = 0; // A'zolar soni
        let memberParts = 1; // A'zolar qismlari soni
        let scannedMessages = 0;

        // Function to update status message
        const updateStatus = async (extra = '') => {
            if (!scrapeSessions[chatId] || scrapeSessions[chatId].status === 'stopped') return;
            const session = scrapeSessions[chatId];
            if (!session.statusMsg) return;
            
            let text = `⏳ **Mention azolarni yig'ish jarayoni...**\n\n`;
            text += `📊 O'qilgan xabarlar: ${scannedMessages}/${historyLimit}\n`;
            text += `🏷 Mention azolar: ${memberCount} ta`;
            if (extra) {
                text += `\n\n⚠️ ${extra}`;
            }
            try {
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: session.statusMsg.message_id,
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "⏹ To'xtatish", callback_data: "scrape_stop" }]
                        ]
                    }
                });
            } catch (e) {
                if (!e.message.includes("message is not modified")) {
                    console.error("Status update error:", e.message);
                }
            }
        };

        // Tarixdan barcha xabarlarni o'qish va mention qilingan userlarni yig'ish
        try {
            for await (const message of client.iterMessages(entity, { limit: historyLimit })) {
                // Check if stopped
                if (scrapeSessions[chatId] && scrapeSessions[chatId].status === 'stopped') {
                    break;
                }
                
                scannedMessages++;

                // Entitiesni tekshirish (faqat @username mentionlari)
                if (message.entities && Array.isArray(message.entities)) {
                    for (const ent of message.entities) {
                        if (ent instanceof Api.MessageEntityMention) {
                            // @username uslubidagi mention
                            const offset = ent.offset;
                            const length = ent.length;
                            const mentionText = message.text?.substring(offset, offset + length);
                            if (mentionText && mentionText.startsWith('@')) {
                                const username = mentionText.substring(1);
                                if (username && !gatheredUserIds.has(username.toLowerCase())) {
                                    members.push({ id: username.toLowerCase(), username: username });
                                    gatheredUserIds.add(username.toLowerCase());
                                    memberCount++;

                                    // Update status every 50 messages or when a user is added
                                    if (scannedMessages % 50 === 0 || memberCount % 10 === 0) {
                                        await updateStatus();
                                    }

                                    // Har 200 ta yig'ilganda darhol yuborish
                                    if (members.length >= 200) {
                                        // Alfavit bo'yicha saralash
                                        members.sort((a, b) => a.username.localeCompare(b.username));
                                        let text = `🏷 **Mention azolar:** ( ${memberCount} ta, ${memberParts} qism )\n\n`;
                                        text += members.map(m => `@${m.username}`).join("\n");
                                        await bot.sendMessage(chatId, text).catch(e => console.error("Batch send error:", e.message));
                                        members.length = 0; // Massivni tozalash
                                        memberParts++; // Qism sonini oshirish
                                        await new Promise(r => setTimeout(r, 2000)); // Flood protection
                                    }
                                }
                            }
                        }
                        // MessageEntityMentionName (ID orqali mention) ni skip qilamiz, chunki undan username ololmaymiz
                    }
                }
                
                // Har 500 ta xabardan keyin kichik tanaffus (Flood protection)
                if (scannedMessages % 500 === 0) {
                    await updateStatus();
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        } catch (e) {
            console.error("History scan xatosi:", e.message);
            if (e.message.includes("FLOOD_WAIT")) {
                const seconds = parseInt(e.message.split("_").pop()) || 10;
                
                // Show flood wait countdown
                for (let i = seconds; i > 0; i--) {
                    if (scrapeSessions[chatId] && scrapeSessions[chatId].status === 'stopped') break;
                    await updateStatus(`FLOOD -- ${i} sekund`);
                    await new Promise(r => setTimeout(r, 1000));
                }
                
                // If not stopped, continue
                if (scrapeSessions[chatId] && scrapeSessions[chatId].status !== 'stopped') {
                    await updateStatus();
                }
            }
        }

        // 5. Yakuniy natija
        const summaryText = `🏁 **NATIJA:**\n\n` +
            `🏷 **Mention azolar:** ${memberCount} ta, ${memberParts} qism\n` +
            `📊 **Jami:** ${gatheredUserIds.size} ta`;
        
        // Save status message reference FIRST
        const mentionSession = scrapeSessions[chatId];
        const mentionStatusMsgObj = mentionSession?.statusMsg || statusMsg;
        
        if (mentionStatusMsgObj && mentionStatusMsgObj.message_id) {
            // Edit status first
            try {
                await bot.editMessageText("✅ Jarayon tugadi!", {
                    chat_id: chatId,
                    message_id: mentionStatusMsgObj.message_id,
                    parse_mode: "Markdown"
                });
            } catch (e) {}
            
            // Unpin
            await bot.unpinChatMessage({ chat_id: chatId, message_id: mentionStatusMsgObj.message_id }).catch(err => console.error("Unpin error:", err.message));
            
            // Delete
            await bot.deleteMessage({ chat_id: chatId, message_id: mentionStatusMsgObj.message_id }).catch(() => {});
        }
        
        // Cleanup session LAST
        if (scrapeSessions[chatId]) {
            delete scrapeSessions[chatId];
        }
        
        // Qolgan a'zolarni yuborish (agar 200 taga yetmagan bo'lsa)
        if (members.length > 0) {
            // Alfavit bo'yicha saralash
            members.sort((a, b) => a.username.localeCompare(b.username));
            let text = `🏷 **Mention azolar:** ( ${memberCount} ta, ${memberParts} qism )\n\n`;
            text += members.map(m => `@${m.username}`).join("\n");
            await bot.sendMessage(chatId, text).catch(e => console.error("Final batch send error:", e.message));
            memberParts++; // Qism sonini oshirish
        }

        // 3. Yakuniy xulosa (ALOIDA)
        await bot.sendMessage(chatId, summaryText, { 
            parse_mode: "Markdown"
        });
        
        // 4. Asosiy menyu (ALOIDA)
        await bot.sendMessage(chatId, "📊 **Asosiy menyu:**", getMainMenu(chatId));

        // Bazani yangilash
        await User.increment({ usersGathered: gatheredUserIds.size }, { where: { chatId } });

        return true;
    } catch (error) { 
        console.error("Scrape mention error:", error);
        throw error; 
    }
};

module.exports = {
    scrapeUsers,
    scrapeMentionUsers
};

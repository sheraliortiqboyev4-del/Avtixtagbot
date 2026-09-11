const config = require('../config');
const Channel = require('../models/Channel');
const axios = require('axios');

const { Api } = require("telegram");

/**
 * Xabarga emoji reaksiya qo'yish (Bot API 7.0+ setMessageReaction).
 * node-telegram-bot-api eski versiyalarida bu metod yo'q, shuning uchun
 * Telegram API'ga to'g'ridan-to'g'ri murojaat qilamiz.
 * @param {string|number} chatId
 * @param {number} messageId
 * @param {string} emoji - reaksiya emojisi (masalan: '👍', '🔥', '❤')
 */
const reactToMessage = async (chatId, messageId, emoji = '❤️') => {
    if (!config.botToken || !messageId) return false;
    try {
        await axios.post(
            `https://api.telegram.org/bot${config.botToken}/setMessageReaction`,
            {
                chat_id: chatId,
                message_id: messageId,
                reaction: [{ type: 'emoji', emoji }],
                is_big: false
            },
            { timeout: 10000 }
        );
        return true;
    } catch (e) {
        // Reaksiya qo'yib bo'lmasa (eski xabar, ruxsat yo'q) — jim o'tkazib yuboramiz
        const desc = e?.response?.data?.description || e.message;
        console.log(`⚠️ [reactToMessage] qo'yib bo'lmadi (${chatId}): ${desc}`);
        return false;
    }
};

// Bot API entitylarini GramJS entitylariga o'tkazish
const convertToGramJsEntities = (entities) => {
    if (!entities || !Array.isArray(entities)) return undefined;
    return entities.map(e => {
        const args = { offset: e.offset, length: e.length };
        
        // Premium emoji (custom_emoji) uchun BigInt handling
        if (e.type === 'custom_emoji' && e.custom_emoji_id) {
            return new Api.MessageEntityCustomEmoji({
                ...args,
                documentId: BigInt(e.custom_emoji_id)
            });
        }

        // Boshqa standart entity turlari
        switch (e.type) {
            case 'bold': return new Api.MessageEntityBold(args);
            case 'italic': return new Api.MessageEntityItalic(args);
            case 'underline': return new Api.MessageEntityUnderline(args);
            case 'strikethrough': return new Api.MessageEntityStrike(args);
            case 'code': return new Api.MessageEntityCode(args);
            case 'pre': return new Api.MessageEntityPre({ ...args, language: '' });
            case 'text_link': return new Api.MessageEntityTextUrl({ ...args, url: e.url });
            case 'text_mention': {
                if (!e.user) return null;
                const userId = BigInt(e.user.id);
                if (e.user.accessHash != null) {
                    return new Api.InputMessageEntityMentionName({
                        ...args,
                        userId: new Api.InputUser({
                            userId,
                            accessHash: BigInt(e.user.accessHash)
                        })
                    });
                }
                return new Api.MessageEntityMentionName({ ...args, userId });
            }
            case 'mention': return new Api.MessageEntityMention(args);
            case 'hashtag': return new Api.MessageEntityHashtag(args);
            case 'bot_command': return new Api.MessageEntityBotCommand(args);
            case 'url': return new Api.MessageEntityUrl(args);
            case 'email': return new Api.MessageEntityEmail(args);
            case 'phone_number': return new Api.MessageEntityPhone(args);
            case 'spoiler': return new Api.MessageEntitySpoiler(args);
            default: return null;
        }
    }).filter(Boolean);
};

// --- BUTTON STYLE/ICON KONSTANTALARI ---
// Inline tugmalarda `icon_custom_emoji_id` (premium emoji) va `style` (rang).
// IZOH: Bu maydonlarni Telegram qo'llab-quvvatlasa ishlaydi; qo'llab-quvvatlamasa
// `text` ichidagi oddiy emoji ko'rinadi (BTN funksiyasi tekstga ham emoji qo'shadi).
const BUTTON_EMOJI_IDS = {
    almaz: '5427168083074628963',
    utag: '5471901288448924312',
    user: '5255883984151276991',
    reyd: '5377725257081696849',
    reklama: '5305548297312675223',
    bonus: '5305687351173849819',
    logout: '5305737159909581647',
    profile: '5305587785241992785',
    admin: '5472187029756332585',
    help: '5366068097365066701',
    back: '5352759161945867747',
    check: '5269481695991580059',
    cancel: '5269501757783819821',
    settings: '5341715473882955310',
    start: '5372917041193828849',
    add: '5397916757333654639',
    remove: '5445267414562389170',
    history: '5197269100878907942',
    random: '5305784520513954243',
    custom: '5305557136355370145',
    share: '5305733135525224451',
    on: '5416081784641168838',
    off: '5411225014148014586',
    pause: '5359543311897998264',
    play: '5348125953090403204',
    stop: '5472030751648127392',
    crown: '5217822164362739968',
    block: '5472267631979405211'
};

const BUTTON_STYLES = {
    primary: 'primary',
    success: 'success',
    danger: 'danger'
};

/**
 * Inline tugma qurish helperi.
 *   text         — tugma matni (oddiy emoji bilan)
 *   callback_data— callback ma'lumoti
 *   opts.iconId  — premium emoji ID (BUTTON_EMOJI_IDS.* dan)
 *   opts.style   — 'primary' | 'success' | 'danger'
 *   opts.url     — url tugma uchun (callback_data o'rniga)
 */
function BTN(text, callback_data, opts = {}) {
    const btn = { text };
    if (opts.url) {
        btn.url = opts.url;
    } else if (callback_data) {
        btn.callback_data = callback_data;
    }
    if (opts.iconId) btn.icon_custom_emoji_id = opts.iconId;
    if (opts.style) btn.style = opts.style;
    return btn;
}

// --- UTAG (auto-tag) uchun custom emoji xaritasi ---
const UTAG_EMOJI_MAP = {
    '💎': '5427168083074628963',
    '🦦': '5215290868660193057',
    '🤨': '5384547500780176510',
    '🧐': '5384389552577924673',
    '🫂': '5377675240752926614',
    '👀': '5396348377963589663',
    '👊': '5377637926958868701',
    '😁': '5377590870628106691',
    '🥱': '5377564889623186510',
    '😾': '5418107220629353248',
    '😆': '5377512388301351619',
    '🫣': '5384422322847048893',
    '😅': '5377498825754430544',
    '😎': '5377466364045904013',
    '😂': '5377414456789450470',
    '💥': '5354132205609396421',
    '💬': '5188377234221450271'
};

/**
 * Utag xabarini tayyorlash. 3 rejim:
 *   1) Username yoki text_mention bilan boshlanadigan mention
 *   2) Custom mode — foydalanuvchi entitylari (msg.entities) saqlanadi
 *   3) Random_words mode — UTAG_EMOJI_MAP'dan custom_emoji entitylari yasaladi
 */
function buildUtagMessage(mentionText, extraText, opts = {}) {
    const { mentionUser = null, useEmojiMap = false, customEntities = null } = opts;
    const fullText = `${mentionText}${extraText || ''}`;
    const entities = [];

    // 1. Mention qismi (boshda)
    if (mentionUser && mentionUser.id) {
        entities.push({
            type: 'text_mention',
            offset: 0,
            length: mentionText.length,
            user: { id: mentionUser.id, accessHash: mentionUser.accessHash || null }
        });
    } else if (mentionText.startsWith('@')) {
        entities.push({
            type: 'mention',
            offset: 0,
            length: mentionText.length
        });
    }

    // 2. Custom mode — foydalanuvchi entitylari saqlanadi
    if (customEntities && customEntities.length > 0) {
        const baseOffset = mentionText.length + (extraText && extraText[0] === ' ' ? 1 : 0);
        for (const ent of customEntities) {
            entities.push({ ...ent, offset: ent.offset + baseOffset });
        }
    } else if (useEmojiMap) {
        // 3. Random_words mode — UTAG_EMOJI_MAP'dan
        const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
        let m;
        while ((m = emojiRegex.exec(fullText)) !== null) {
            const emoji = m[0];
            let id = UTAG_EMOJI_MAP[emoji] || UTAG_EMOJI_MAP[emoji + '\uFE0F'];
            if (id) {
                entities.push({
                    type: 'custom_emoji',
                    offset: m.index,
                    length: emoji.length,
                    custom_emoji_id: id
                });
            }
        }
    }

    entities.sort((a, b) => a.offset - b.offset);
    return { cleanText: fullText, entities };
}

// Premium Emojilar xaritasi
const EMOJI_MAP = {
    '💎': '5427168083074628963',
    '❌': '5210952531676504517',
    '✅': '5462919317832082236',
    '⚠️': '5420323339723881652',
    '👨': '5474667187258006816', 
    '💼': '5359785904535774578', 
    '⏳': '5451732530048802485',
    '👤': '5305291329419354124', 
    '🆔': '5334890573281114250',
    '📢': '5305548297312675223',
    '💻': '5366288132834599020',
    '🧾': '5305295963689067405',
    '⚔️': '5408935401442267103', 
    '📣': '5424818078833715060', 
    '📊': '5231200819986047254',
    '🔄': '5264727218734524899',
    '👥': '5305733135525224451',
    '🚫': '5472267631979405211',
    '🔙': '5253997076169115797',
    '🚀': '5445284980978621387',
    '📅': '5472100751025118421',
    '👋': '5472427507842032538',
    '👇': '5470177992950946662',
    '🆕': '5265244349976832702',
    '🔗': '5305789962237518029',
    '⛔': '5260293700088511294',
    'ℹ️': '5334544901428229844',
    '🤖': '5372981976804366741',
    '🎉': '5388674524583572460',
    '👑': '5217822164362739968',
    '📛': '5260293700088511294',
    '🔰': '5282843764451195532',
    '📋': '5174771276203427153',
    '📌': '5397782960512444700',
    '📂': '5431721976769027887',
    '⚙️': '5341715473882955310',
    '🟢': '5416081784641168838',
    '🔴': '5411225014148014586',
    '🔌': '5339517760592421605',
    '⏸': '5359543311897998264',
    '⏹': '5467643373835815896',
    '🛑': '5472030751648127392',
    '▶️': '5348125953090403204',
    '🔢': '5467370987009909520',
    '📝': '5334890573281114250',
    '🔐': '5472308992514464048',
    '🏁': '5411520005386806155',
    '📦': '5271923685547058434',
    '🎁': '5190527303599283765',
    '💵': '5215239948420003628',
    '👉': '5471978009449731768',
    '✍️': '5470060791883374114',
    '📞': '5467538555158943525',
    '⏰': '4904882772637648609',
    '🏷': '5471901288448924312',
    '🔓': '5465443379917629504',
    '📱': '5471960722206366390',
    '📍': '5228967510006580700',
};

// UTF-16 asosida matn uzunligini to'g'ri hisoblash (Telegram uchun .length kifoya)
const getUtf16Length = (str) => str.length;

// Matn ichidan barcha emojilarni topib, ularni custom_emoji entitylariga aylantiruvchi universal funksiya
function withPremiumEmojis(text) {
    if (!text) return { cleanText: "", entities: [] };
    let entities = [];
    let cleanText = text;

    // 1. Markdown va Custom Emojilarni qayta ishlash
    // Muhim: Markdown belgilarini olib tashlashda offsetlarni to'g'ri hisoblash kerak
    
    // Bold (**text**)
    const boldRegex = /\*\*(.*?)\*\*/g;
    let boldMatch;
    while ((boldMatch = boldRegex.exec(cleanText)) !== null) {
        const fullMatch = boldMatch[0];
        const innerText = boldMatch[1];
        const offset = boldMatch.index;
        const length = innerText.length;

        entities.push({ type: "bold", offset, length });
        
        // cleanText'ni yangilaymiz (belgilarini olib tashlaymiz)
        cleanText = cleanText.slice(0, offset) + innerText + cleanText.slice(offset + fullMatch.length);
        
        // Regex lastIndex'ni yangilangan matnga moslashtiramiz
        boldRegex.lastIndex = offset + length;
    }

    // Code (`text`)
    const codeRegex = /`(.*?)`/g;
    let codeMatch;
    while ((codeMatch = codeRegex.exec(cleanText)) !== null) {
        const fullMatch = codeMatch[0];
        const innerText = codeMatch[1];
        const offset = codeMatch.index;
        const length = innerText.length;

        entities.push({ type: "code", offset, length });
        
        cleanText = cleanText.slice(0, offset) + innerText + cleanText.slice(offset + fullMatch.length);
        codeRegex.lastIndex = offset + length;
    }

    // 2. Standart Telegram entitylari (Commands, Mentions)
    // Bu entitylar cleanText o'zgarmaganda ham ishlaydi
    
    // Commands (/start)
    const commandRegex = /(\/[a-zA-Z0-9_]+)/g;
    let cmdMatch;
    while ((cmdMatch = commandRegex.exec(cleanText)) !== null) {
        entities.push({ type: "bot_command", offset: cmdMatch.index, length: cmdMatch[0].length });
    }

    // Mentions (@username)
    const mentionRegex = /(@[a-zA-Z0-9_]+)/g;
    let mMatch;
    while ((mMatch = mentionRegex.exec(cleanText)) !== null) {
        entities.push({ type: "mention", offset: mMatch.index, length: mMatch[0].length });
    }

    // 3. Premium Emojilar (Custom Emojis)
    const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
    let eMatch;
    while ((eMatch = emojiRegex.exec(cleanText)) !== null) {
        const emoji = eMatch[0];
        let mappedId = EMOJI_MAP[emoji];
        
        if (!mappedId && EMOJI_MAP[emoji + '\uFE0F']) mappedId = EMOJI_MAP[emoji + '\uFE0F'];
        else if (!mappedId && emoji.endsWith('\uFE0F') && EMOJI_MAP[emoji.slice(0, -1)]) mappedId = EMOJI_MAP[emoji.slice(0, -1)];

        if (mappedId) {
            entities.push({
                type: "custom_emoji",
                offset: eMatch.index,
                length: emoji.length,
                custom_emoji_id: mappedId
            });
        }
    }

    // Entitylarni offset bo'yicha saralaymiz (Telegram talabi)
    entities.sort((a, b) => a.offset - b.offset);

    return { cleanText, entities };
}

const escapeMarkdown = (text) => text ? text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&') : ""; 

const escapeHTML = (text) => {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
};

const chunkArray = (array, size) => {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
};

const parseTime = (input) => { 
    const units = { 'kun': 86400000, 'soat': 3600000, 'minut': 60000, 'oy': 2592000000, 'daqiqa': 60000 }; 
    let totalMs = 0; 
    const regex = /(\d+)\s*(kun|soat|minut|daqiqa|oy)/gi; 
    let match, found = false; 
    while ((match = regex.exec(input)) !== null) { 
        totalMs += parseInt(match[1]) * (units[match[2].toLowerCase()] || 0); 
        found = true; 
    } 
    return found ? totalMs : 0; 
}; 

const formatRemainingTime = (expireAt) => { 
    if (!expireAt) return "Cheksiz 👑"; 
    const diff = new Date(expireAt) - new Date(); 
    if (diff <= 0) return "Tugagan ❌"; 
    const d = Math.floor(diff / 86400000), h = Math.floor((diff % 86400000) / 3600000); 
    return `${d} kun ${h} soat qoldi`; 
}; 

/** Telegram inline tugma uchun to'g'ri https://t.me/... link */
function normalizeTelegramUrl(raw) {
    if (!raw) return null;
    let url = String(raw).trim();
    if (!url) return null;

    if (/^https?:\/\//i.test(url)) {
        return url.replace(/^http:\/\//i, 'https://');
    }
    if (/^(t\.me|telegram\.me)\//i.test(url)) {
        return `https://${url}`;
    }
    if (url.startsWith('@')) {
        return `https://t.me/${url.slice(1)}`;
    }
    if (/^[a-zA-Z0-9_]{4,}$/.test(url)) {
        return `https://t.me/${url}`;
    }
    return null;
}

// Helper: Obuna tekshirish
async function checkMembership(bot, userId) {
    if (config.adminId && userId.toString() === config.adminId.toString()) return true; 
    
    try {
        const channels = await Channel.findAll();
        if (channels.length === 0) return true;

        for (const channel of channels) {
            try {
                const chatMember = await bot.getChatMember(channel.channelId, userId);
                // Member statuses that are considered "subscribed"
                const subscribedStatuses = ['creator', 'administrator', 'member'];
                if (!subscribedStatuses.includes(chatMember.status)) {
                    return false;
                }
            } catch (e) {
                console.error(`Kanalga a'zolikni tekshirishda xatolik (${channel.channelId}):`, e.message);
                // Agar kanal topilmasa yoki bot admin bo'lmasa, xavfsizlik uchun false qaytaramiz
                // Bu adminni kanallarni to'g'ri sozlashga majbur qiladi
                if (e.message.includes("chat not found") || e.message.includes("bot is not a member")) {
                    // return false; // Bu yerda false qaytarish foydalanuvchini bloklab qo'yishi mumkin
                }
            }
        }
        return true;
    } catch (err) {
        console.error("checkMembership global error:", err.message);
        return true; // Xatolik bo'lsa bot to'xtab qolmasligi uchun true
    }
}

// Helper: Obuna xabari
async function sendSubscriptionAsk(bot, chatId) {
    const channels = await Channel.findAll();
    const buttons = [];

    for (const channel of channels) {
        const url = normalizeTelegramUrl(channel.url);
        if (!url) {
            console.error(`Kanal URL noto'g'ri (${channel.name}): ${channel.url}`);
            continue;
        }
        buttons.push([{ text: `📢 ${channel.name} ga a'zo bo'lish`, url }]);
    }

    buttons.push([{ text: "✅ Tekshirish", callback_data: "check_subscription" }]);

    const text = buttons.length > 1
        ? "⚠️ **Botdan foydalanish uchun quyidagi kanallarga a'zo bo'ling:**\n\nA'zo bo'lgandan so'ng \"✅ Tekshirish\" tugmasini bosing."
        : "⚠️ **Majburiy obuna kanallari sozlanmagan yoki linklar noto'g'ri.**\n\nAdmin bilan bog'laning.";

    try {
        await bot.sendMessage(chatId, text, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (e) {
        console.error('sendSubscriptionAsk xatosi:', e.message);
        await bot.sendMessage(chatId, text, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [[{ text: "✅ Tekshirish", callback_data: "check_subscription" }]]
            }
        }).catch(() => {});
    }
}

// Helper: Asosiy menyu (Inline)
function getMainMenu(chatId) {
    const isAdmin = config.adminId && chatId.toString() === config.adminId.toString();
    const lastRow = isAdmin
        ? [
            BTN("Admin Panel", "admin_panel", { iconId: BUTTON_EMOJI_IDS.admin, style: BUTTON_STYLES.primary }),
            BTN("Yordam", "menu_help", { iconId: BUTTON_EMOJI_IDS.help, style: BUTTON_STYLES.primary })
        ]
        : [BTN("Yordam", "menu_help", { iconId: BUTTON_EMOJI_IDS.help, style: BUTTON_STYLES.primary })];

    return {
        reply_markup: {
            inline_keyboard: [
                [
                    BTN("Avto Utag",  "menu_utag",    { iconId: BUTTON_EMOJI_IDS.utag,    style: BUTTON_STYLES.primary })
                ],
                [
                    BTN("Avto Reklama", "menu_reklama", { iconId: BUTTON_EMOJI_IDS.reklama, style: BUTTON_STYLES.primary })
                ],
                [
                    BTN("Profil", "menu_profile", { iconId: BUTTON_EMOJI_IDS.profile, style: BUTTON_STYLES.primary }),
                    BTN("Chiqish", "menu_logout", { iconId: BUTTON_EMOJI_IDS.logout, style: BUTTON_STYLES.danger })
                ],
                ...(lastRow.length ? [lastRow] : [])
            ]
        }
    };
}

// Helper: Avto Almaz Menyu
const getAlmazMenu = (isEnabled) => {
    const onOffBtn = isEnabled
        ? BTN("O'chirish", "almaz_off", { iconId: BUTTON_EMOJI_IDS.off, style: BUTTON_STYLES.danger })
        : BTN("Yoqish",    "almaz_on",  { iconId: BUTTON_EMOJI_IDS.on,  style: BUTTON_STYLES.success });

    return {
        reply_markup: {
            inline_keyboard: [
                [onOffBtn],
                [BTN("Orqaga", "menu_back_main", { iconId: BUTTON_EMOJI_IDS.back, style: BUTTON_STYLES.primary })]
            ]
        }
    };
};

/** Guruh ID bo'yicha tarixda bitta yozuv */
function normalizeUtagGroupId(idOrLink) {
    const s = String(idOrLink).trim();
    if (/^-?\d+$/.test(s)) return s;
    return s;
}

function upsertUtagHistory(history, entry) {
    const id = normalizeUtagGroupId(entry.id);
    const list = (history || []).filter((h) => normalizeUtagGroupId(h.id) !== id);
    list.push({
        id,
        title: entry.title || 'Guruh',
        link: entry.link || id,
        mode: entry.mode || 'only_mention',
        limit: entry.limit ?? 0,
        tagText: entry.tagText || null,
        memberFilter: entry.memberFilter || 'all',
        updatedAt: new Date().toISOString()
    });
    return list.slice(-15);
}

function getUtagSetupKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    BTN("Faqat online", 'utag_filter_online', { iconId: BUTTON_EMOJI_IDS.on,    style: BUTTON_STYLES.primary }),
                    BTN("Hammani",      'utag_filter_all',    { iconId: BUTTON_EMOJI_IDS.share, style: BUTTON_STYLES.primary })
                ],
                [BTN("Bekor", 'menu_utag', { iconId: BUTTON_EMOJI_IDS.cancel, style: BUTTON_STYLES.danger })]
            ]
        }
    };
}

function getUtagModeKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [BTN("@ Foydalanuvchi o'zi",     'utag_mode_only_mention', { iconId: BUTTON_EMOJI_IDS.user,   style: BUTTON_STYLES.primary })],
                [BTN("Tasodifiy so'zlar (bot)", 'utag_mode_random_words', { iconId: BUTTON_EMOJI_IDS.random, style: BUTTON_STYLES.primary })],
                [BTN("O'z matnim bilan",         'utag_mode_custom',       { iconId: BUTTON_EMOJI_IDS.custom, style: BUTTON_STYLES.primary })]
            ]
        }
    };
}

function getUtagMenu(accountMode = 'main', rekCount = 0) {
    const modeText = accountMode === 'all' ? "Barcha akkauntlar" : "Faqat asosiy";
    return {
        reply_markup: {
            inline_keyboard: [
                [BTN("Yangi boshlash",              "utag_start_new",     { iconId: BUTTON_EMOJI_IDS.start,    style: BUTTON_STYLES.primary })],
                [BTN(`Rejim: ${modeText}`,           "utag_change_mode",   { iconId: BUTTON_EMOJI_IDS.settings, style: BUTTON_STYLES.primary })],
                [
                    BTN(`Akkaunt qo'shish (${rekCount}/10)`, "utag_add_acc",   { iconId: BUTTON_EMOJI_IDS.add,    style: BUTTON_STYLES.success }),
                    BTN("Tozalash",                          "utag_clear_acc", { iconId: BUTTON_EMOJI_IDS.remove, style: BUTTON_STYLES.danger })
                ],
                [BTN("Tarix",            "utag_history",       { iconId: BUTTON_EMOJI_IDS.history, style: BUTTON_STYLES.primary })],
                [BTN("Tarixni tozalash", "utag_clear_history", { iconId: BUTTON_EMOJI_IDS.remove,  style: BUTTON_STYLES.danger })],
                [BTN("Orqaga",           "menu_back_main",     { iconId: BUTTON_EMOJI_IDS.back,    style: BUTTON_STYLES.primary })]
            ]
        }
    };
}

function getReklamaMenu(accountMode = 'main', accountsCount = 0) {
    const modeText = accountMode === 'all' ? "Barcha akkauntlar" : "Faqat asosiy";
    return {
        reply_markup: {
            inline_keyboard: [
                [BTN("Reklama boshlash",                       "reklama_start",       { iconId: BUTTON_EMOJI_IDS.start,    style: BUTTON_STYLES.primary })],
                [BTN(`Rejim: ${modeText}`,                      "reklama_change_mode", { iconId: BUTTON_EMOJI_IDS.settings, style: BUTTON_STYLES.primary })],
                [BTN(`Akkaunt qo'shish (${accountsCount}/10)`, "reklama_add_acc",     { iconId: BUTTON_EMOJI_IDS.add,      style: BUTTON_STYLES.success })],
                [BTN("Akkauntlarni tozalash",                   "reklama_clear_acc",   { iconId: BUTTON_EMOJI_IDS.remove,   style: BUTTON_STYLES.danger })],
                [BTN("Orqaga",                                  "menu_back_main",      { iconId: BUTTON_EMOJI_IDS.back,     style: BUTTON_STYLES.primary })]
            ]
        }
    };
}

function getReydMenu(accountMode = 'main', accountsCount = 0) {
    const modeText = accountMode === 'all' ? "Barcha akkauntlar" : "Faqat asosiy";
    return {
        reply_markup: {
            inline_keyboard: [
                [BTN("Reyd boshlash",                          "reyd_start",       { iconId: BUTTON_EMOJI_IDS.start,    style: BUTTON_STYLES.success })],
                [BTN(`Rejim: ${modeText}`,                      "reyd_change_mode", { iconId: BUTTON_EMOJI_IDS.settings, style: BUTTON_STYLES.primary })],
                [BTN(`Akkaunt qo'shish (${accountsCount}/10)`, "reyd_add_acc",     { iconId: BUTTON_EMOJI_IDS.add,      style: BUTTON_STYLES.success })],
                [BTN("Akkauntlarni tozalash",                   "reyd_clear_acc",   { iconId: BUTTON_EMOJI_IDS.remove,   style: BUTTON_STYLES.danger })],
                [BTN("Orqaga",                                  "menu_reyd",        { iconId: BUTTON_EMOJI_IDS.back,     style: BUTTON_STYLES.primary })]
            ]
        }
    };
}

// Helper: Avto Ban — tezlik tanlash menyusi
function getBanSpeedKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [BTN("Sekin (xavfsiz)", "ban_speed_slow",   { iconId: BUTTON_EMOJI_IDS.settings, style: BUTTON_STYLES.primary })],
                [BTN("O'rtacha",        "ban_speed_normal", { iconId: BUTTON_EMOJI_IDS.settings, style: BUTTON_STYLES.primary })],
                [BTN("Tez (xavfli)",    "ban_speed_fast",   { iconId: BUTTON_EMOJI_IDS.start,    style: BUTTON_STYLES.danger })],
                [BTN("Orqaga",          "menu_reyd",        { iconId: BUTTON_EMOJI_IDS.back,     style: BUTTON_STYLES.primary })]
            ]
        }
    };
}

// Helper: Avto Ban — kimlarni tanlash
function getBanFilterKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [BTN("Hammani",         "ban_filter_all",    { iconId: BUTTON_EMOJI_IDS.share,    style: BUTTON_STYLES.primary })],
                [BTN("Onlinelarni",     "ban_filter_online", { iconId: BUTTON_EMOJI_IDS.on,       style: BUTTON_STYLES.success })],
                [BTN("Ma'lum miqdorni", "ban_filter_count",  { iconId: BUTTON_EMOJI_IDS.settings, style: BUTTON_STYLES.primary })],
                [BTN("Orqaga",          "menu_reyd",         { iconId: BUTTON_EMOJI_IDS.back,     style: BUTTON_STYLES.primary })]
            ]
        }
    };
}

// Helper: Admin Menyu
function getAdminMenu(approvalRequired = true) {
    const approvalText = approvalRequired ? "Tasdiqlash: YOQILGAN" : "Tasdiqlash: O'CHIRILGAN";
    const approvalAction = approvalRequired ? "admin_approval_off" : "admin_approval_on";
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    BTN("Statistika",      "admin_stats",      { iconId: BUTTON_EMOJI_IDS.profile, style: BUTTON_STYLES.primary }),
                    BTN("Barcha A'zolar", "admin_all_users",  { iconId: BUTTON_EMOJI_IDS.share,   style: BUTTON_STYLES.primary })
                ],
                [
                    BTN("Kutilayotganlar", "admin_pending",   { iconId: BUTTON_EMOJI_IDS.history, style: BUTTON_STYLES.primary }),
                    BTN("Tasdiqlanganlar", "admin_approved",  { iconId: BUTTON_EMOJI_IDS.check,   style: BUTTON_STYLES.success })
                ],
                [
                    BTN("Bloklanganlar",   "admin_blocked",   { iconId: BUTTON_EMOJI_IDS.block,   style: BUTTON_STYLES.danger }),
                    BTN("Barchaga Xabar",  "admin_broadcast", { iconId: BUTTON_EMOJI_IDS.reklama, style: BUTTON_STYLES.primary })
                ],
                [BTN("Kanallar sozlamasi", "admin_channels",  { iconId: BUTTON_EMOJI_IDS.settings, style: BUTTON_STYLES.primary })],
                [BTN(approvalText, approvalAction, { iconId: approvalRequired ? BUTTON_EMOJI_IDS.on : BUTTON_EMOJI_IDS.off, style: approvalRequired ? BUTTON_STYLES.success : BUTTON_STYLES.danger })],
                [BTN("Orqaga",             "menu_back_main",  { iconId: BUTTON_EMOJI_IDS.back,     style: BUTTON_STYLES.primary })]
            ]
        }
    };
}

// Foydalanuvchi guruh admini ekanligini tekshirish
const isUserAdmin = async (bot, chatId, userId) => {
    try {
        if (chatId === userId) return true; // Shaxsiy chatda o'zi admin
        const member = await bot.getChatMember(chatId, userId);
        return ['creator', 'administrator'].includes(member.status);
    } catch (e) {
        console.error("Admin check error:", e.message);
        return false;
    }
};

function getPendingPaymentKeyboard() {
    return {
        inline_keyboard: [
            [BTN("Admin", null, { url: "https://t.me/id_uzzz", iconId: BUTTON_EMOJI_IDS.admin, style: BUTTON_STYLES.primary })]
        ]
    };
}

/** Guruh tanlash (request_chat) — har bir funksiya uchun alohida request_id */
const SCRAPE_CHAT_REQUEST_ID = 1;
const REYD_CHAT_REQUEST_ID = 2;
const UTAG_CHAT_REQUEST_ID = 3;
const BAN_CHAT_REQUEST_ID = 4;

function getGroupPickerKeyboard(requestId) {
    return {
        keyboard: [
            [{
                text: '👥 𝗚𝘂𝗿𝘂𝘅',
                request_chat: {
                    request_id: requestId,
                    chat_is_channel: false,
                    chat_is_forum: false,
                    bot_is_member: false
                }
            }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
        is_persistent: false
    };
}

function getAvtoUserGroupPickerKeyboard() {
    return getGroupPickerKeyboard(SCRAPE_CHAT_REQUEST_ID);
}

function getPhoneShareKeyboard() {
    return {
        keyboard: [[{ text: '📱 𝗧𝗲𝗹𝗲𝗳𝗼𝗻 𝗿𝗮𝗾𝗮𝗺𝗻𝗶 𝘂𝗹𝗮𝘀𝗵𝗶𝘀𝗵', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
        is_persistent: false
    };
}

function parseSharedGroup(chatShared) {
    return {
        id: String(chatShared.chat_id),
        title: chatShared.title || chatShared.username || '𝗚𝘂𝗿𝘂𝘅'
    };
}

function normalizePhoneInput(input) {
    let phoneNumber = String(input).replace(/\s+/g, '').replace(/[^\d+]/g, '');
    if (!phoneNumber.startsWith('+')) {
        if (phoneNumber.length === 9) {
            phoneNumber = '+998' + phoneNumber;
        } else if (phoneNumber.length === 12) {
            phoneNumber = '+' + phoneNumber;
        }
    }
    return phoneNumber;
}

function removeKeyboardMarkup() {
    return { reply_markup: { remove_keyboard: true } };
}

module.exports = { 
    escapeMarkdown, 
    escapeHTML,
    chunkArray,
    parseTime, 
    formatRemainingTime, 
    withPremiumEmojis, 
    convertToGramJsEntities,
    getUtf16Length,
    normalizeTelegramUrl,
    checkMembership, 
    sendSubscriptionAsk, 
    getMainMenu, 
    getAlmazMenu,
    getUtagMenu,
    normalizeUtagGroupId,
    upsertUtagHistory,
    getUtagSetupKeyboard,
    getUtagModeKeyboard,
    getReklamaMenu,
    getReydMenu,
    getBanSpeedKeyboard,
    getBanFilterKeyboard,
    getAdminMenu,
    getPendingPaymentKeyboard,
    getAvtoUserGroupPickerKeyboard,
    getGroupPickerKeyboard,
    getPhoneShareKeyboard,
    parseSharedGroup,
    normalizePhoneInput,
    removeKeyboardMarkup,
    SCRAPE_CHAT_REQUEST_ID,
    REYD_CHAT_REQUEST_ID,
    UTAG_CHAT_REQUEST_ID,
    BAN_CHAT_REQUEST_ID,
    isUserAdmin,
    EMOJI_MAP,
    UTAG_EMOJI_MAP,
    BUTTON_EMOJI_IDS,
    BUTTON_STYLES,
    BTN,
    buildUtagMessage,
    reactToMessage
};

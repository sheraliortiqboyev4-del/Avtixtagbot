const config = require('../config');
const Channel = require('../models/Channel');

const { Api } = require("telegram");

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
            case 'pre': return new Api.MessageEntityPre({ ...args, language: e.language || '' });
            case 'text_link': return new Api.MessageEntityTextUrl({ ...args, url: e.url });
            case 'text_mention': return e.user ? new Api.MessageEntityMentionName({ ...args, userId: BigInt(e.user.id) }) : null;
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
    '📝': '5334882760735598374',
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
        
        // cleanText'ni yangilaymiz (belgilarni olib tashlaymiz)
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
        ? [{ text: "👨‍💻 Admin Panel", callback_data: "admin_panel" }]
        : [{ text: "🧾 Yordam", callback_data: "menu_help" }];

    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "💎 Avto Almaz", callback_data: "menu_almaz" }, { text: "🏷 Avto UTag", callback_data: "menu_utag" }],
                [{ text: "👤 AvtoUser", callback_data: "menu_avtouser" }, { text: "⚔️ Avto Reyd", callback_data: "menu_reyd" }],
                [{ text: "📣 Avto Reklama", callback_data: "menu_reklama" }, { text: "📊 Profil", callback_data: "menu_profile" }],
                [{ text: "🎁 Bonus", callback_data: "menu_bonus" }],
                [{ text: "🔄 Nomer almashtirish", callback_data: "menu_logout" }],
                lastRow
            ]
        }
    };
}

// Helper: Avto Almaz Menyu
const getAlmazMenu = (isEnabled) => {
    const buttonText = isEnabled ? "🔴 O'chirish" : "🟢 Yoqish";
    const buttonAction = isEnabled ? "almaz_off" : "almaz_on";

    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: buttonText, callback_data: buttonAction }],
                [{ text: "◀️ Orqaga", callback_data: "menu_back_main" }]
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
                    { text: '🟢 Faqat online', callback_data: 'utag_filter_online' },
                    { text: '👥 Hammani', callback_data: 'utag_filter_all' }
                ],
                [{ text: '❌ Bekor', callback_data: 'menu_utag' }]
            ]
        }
    };
}

function getUtagModeKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "👤 @ Foydalanuvchi o'zi", callback_data: 'utag_mode_only_mention' }],
                [{ text: "💬 Tasodifiy so'zlar (bot)", callback_data: 'utag_mode_random_words' }],
                [{ text: "✍️ O'z matnim bilan", callback_data: 'utag_mode_custom' }]
            ]
        }
    };
}

function getUtagMenu(accountMode = 'main', rekCount = 0) {
    const modeText = accountMode === 'all' ? "🌐 Barcha akkauntlar" : "👤 Faqat asosiy";
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🚀 Yangi boshlash", callback_data: "utag_start_new" }],
                [{ text: `⚙️ Rejim: ${modeText}`, callback_data: "utag_change_mode" }],
                [
                    { text: `➕ Akkaunt qo'shish (${rekCount}/10)`, callback_data: "reklama_add_acc" },
                    { text: "🗑 Tozalash", callback_data: "reklama_clear_accs" }
                ],
                [{ text: "📂 Tarix", callback_data: "utag_history" }],
                [{ text: "🗑 Tarixni tozalash", callback_data: "utag_clear_history" }],
                [{ text: "🔙 Orqaga", callback_data: "menu_back_main" }]
            ]
        }
    };
}

function getReklamaMenu(accountsCount = 0) {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🚀 Reklama boshlash", callback_data: "reklama_start" }],
                [{ text: `➕ Akkaunt qo'shish (${accountsCount}/10)`, callback_data: "reklama_add_acc" }],
                [{ text: "🗑 Akkauntlarni tozalash", callback_data: "reklama_clear_acc" }],
                [{ text: "🔙 Orqaga", callback_data: "menu_back_main" }]
            ]
        }
    };
}

function getReydMenu(accountsCount = 0) {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🚀 Reyd boshlash", callback_data: "reyd_start" }],
                [{ text: `➕ Akkaunt qo'shish (${accountsCount}/10)`, callback_data: "reyd_add_acc" }],
                [{ text: "🗑 Akkauntlarni tozalash", callback_data: "reyd_clear_acc" }],
                [{ text: "🔙 Orqaga", callback_data: "menu_back_main" }]
            ]
        }
    };
}

// Helper: Admin Menyu
function getAdminMenu() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📊 Statistika", callback_data: "admin_stats" }, { text: "👥 Barcha A'zolar", callback_data: "admin_all_users" }],
                [{ text: "⏳ Kutilayotganlar", callback_data: "admin_pending" }, { text: "✅ Tasdiqlanganlar", callback_data: "admin_approved" }],
                [{ text: "🚫 Bloklanganlar", callback_data: "admin_blocked" }, { text: "📣 Barchaga Xabar", callback_data: "admin_broadcast" }],
                [{ text: "📢 Kanallar sozlamasi", callback_data: "admin_channels" }],
                [{ text: "🎁 Bonus tizimi", callback_data: "admin_bonus" }],
                [{ text: "🔙 Orqaga", callback_data: "menu_back_main" }]
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

function getBonusCoinRow() {
    return [{ text: "🎁 Bonus", callback_data: "menu_bonus" }];
}

function getPendingPaymentKeyboard() {
    return {
        inline_keyboard: [
            [{ text: "🎁 Bonus Olish", callback_data: "menu_bonus" }],
            [
                { text: "👨‍💼 Admin", url: "https://t.me/ortiqov_x7" }
            ]
        ]
    };
}

function getAdminCoinKeyboard(targetId) {
    const id = String(targetId);
    return [
        [{ text: "➖ Coin yechib olish", callback_data: `admin_coins_deduct_${id}` }],
        [{ text: "✏️ Coin belgilash", callback_data: `admin_coins_set_${id}` }]
    ];
}

/** Guruh tanlash (request_chat) — har bir funksiya uchun alohida request_id */
const SCRAPE_CHAT_REQUEST_ID = 1;
const REYD_CHAT_REQUEST_ID = 2;
const UTAG_CHAT_REQUEST_ID = 3;

function getGroupPickerKeyboard(requestId) {
    return {
        keyboard: [
            [{
                text: '👥 Guruh',
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
        keyboard: [[{ text: '📱 Telefon raqamni ulashish', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
        is_persistent: false
    };
}

function parseSharedGroup(chatShared) {
    return {
        id: String(chatShared.chat_id),
        title: chatShared.title || chatShared.username || 'Guruh'
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
    getAdminMenu,
    getBonusCoinRow,
    getPendingPaymentKeyboard,
    getAdminCoinKeyboard,
    getAvtoUserGroupPickerKeyboard,
    getGroupPickerKeyboard,
    getPhoneShareKeyboard,
    parseSharedGroup,
    normalizePhoneInput,
    removeKeyboardMarkup,
    SCRAPE_CHAT_REQUEST_ID,
    REYD_CHAT_REQUEST_ID,
    UTAG_CHAT_REQUEST_ID,
    isUserAdmin,
    EMOJI_MAP
};

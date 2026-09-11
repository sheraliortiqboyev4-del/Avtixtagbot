/**
 * Userbot Shared State va umumiy helperlar
 * (Kodlar originaldan o'zgartirilmasdan ko'chirilgan)
 */

const https = require('https');
const config = require("../config");
const User = require("../models/User");
const { triggerBackup } = require('../utils/dbBackup');

// --- GLOBAL STATE (barcha modullar shu obyektlarni baham ko'radi) ---
const userClients = {};
const avtoAlmazStates = {};
const utagStates = {};
const reklamaStates = {};
const reydSessions = {}; // { chatId: { status: 'running'|'stopped' } }
const scrapeSessions = {}; // Tracks active scraping sessions
const banSessions = {}; // Avto Ban jarayonlari

const getPromoBot = () => {
    const u = (config.botPromoUsername || '@Foydasizku_bot').trim();
    return u.startsWith('@') ? u : `@${u}`;
};

const PROMO_UTAG = () => `Utag ${getPromoBot()} orqali yuborildi.`;
const PROMO_REKLAMA = () => `Reklama ${getPromoBot()} orqali yuborildi`;

// --- YORDAMCHI FUNKSIYALAR ---
const getUser = async (chatId) => {
    return await User.findOne({ where: { chatId } });
};

const updateStats = async (chatId) => {
    return await User.increment({ clicks: 1 }, { where: { chatId } });
};

const downloadFile = (url) => {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Failed to download file: ${res.statusCode}`));
                return;
            }
            const data = [];
            res.on('data', (chunk) => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', reject);
    });
};

const blockExpiredUser = async (user, bot, options = {}) => {
    const { skipBackup = false } = options;
    const chatId = user.chatId;

    const fresh = await User.findOne({ where: { chatId } });
    if (!fresh || fresh.status === 'blocked') return false;
    if (!fresh.expireAt || new Date(fresh.expireAt) >= new Date()) return false;

    console.log(`[Expiry] User ${chatId} muddati tugadi va bloklandi.`);
    await User.update(
        {
            status: 'blocked',
            session: null,
            reydAccounts: [],
            reklamaAccounts: []
        },
        { where: { chatId } }
    );

    if (userClients[chatId]) {
        try { await userClients[chatId].disconnect(); delete userClients[chatId]; } catch (e) {}
    }

    const texts = require('../utils/texts');
    const blockedText = texts.payment.expired(texts.admin.username);
    bot.sendMessage(chatId, blockedText, {
        parse_mode: "Markdown",
        skipEmojiWrap: true,
        reply_markup: {
            inline_keyboard: [[{ text: "👨‍💼 Admin bilan bog'lanish", url: "https://t.me/id_uzzz" }]]
        }
    }).catch(() => {});

    if (!skipBackup) {
        triggerBackup('muddat_tugadi', true);
    }
    return true;
};

module.exports = {
    userClients,
    avtoAlmazStates,
    utagStates,
    reklamaStates,
    reydSessions,
    scrapeSessions,
    banSessions,
    getPromoBot,
    PROMO_UTAG,
    PROMO_REKLAMA,
    getUser,
    updateStats,
    downloadFile,
    blockExpiredUser
};

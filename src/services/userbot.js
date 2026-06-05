/**
 * Userbot — markaziy export (orqaga moslik uchun)
 *
 * Eski userbot.js (2100+ qator) modullarga ajratildi.
 * Barcha funksiyalar va state originaldagidek nomlar bilan eksport qilinadi,
 * shuning uchun mavjud `require('../services/userbot')` chaqiruvlari o'zgarmasdan ishlaydi.
 *
 * Modullar:
 *  - userbotState.js          : umumiy state (userClients, *States, *Sessions) + helperlar
 *  - clientManager.js         : startUserbot, ensureClient, loadAllStates, attachAlmazHandlers
 *  - auth/authService.js      : initAuth, handleAuthStep, resendAuthCode
 *  - scraping/scrapeService.js: scrapeUsers, scrapeMentionUsers
 *  - features/reydService.js  : startReyd
 *  - features/reklamaService.js: startReklama
 *  - tagging/utagService.js   : startAutoTag
 */

const {
    userClients,
    avtoAlmazStates,
    utagStates,
    reklamaStates,
    reydSessions,
    scrapeSessions,
    banSessions,
    blockExpiredUser
} = require('./userbotState');

const { startUserbot, loadAllStates } = require('./clientManager');
const { initAuth, handleAuthStep, resendAuthCode } = require('./auth/authService');
const { scrapeUsers, scrapeMentionUsers } = require('./scraping/scrapeService');
const { startReyd } = require('./features/reydService');
const { startReklama } = require('./features/reklamaService');
const { startAutoTag } = require('./tagging/utagService');
const { prepareBan, startBan, BAN_SPEEDS } = require('./features/banService');

module.exports = {
    userClients, avtoAlmazStates, utagStates, reklamaStates, reydSessions, scrapeSessions, banSessions, startUserbot, blockExpiredUser,
    initAuth, handleAuthStep, resendAuthCode, scrapeUsers, scrapeMentionUsers, startReyd, startReklama, startAutoTag, loadAllStates,
    prepareBan, startBan, BAN_SPEEDS
};

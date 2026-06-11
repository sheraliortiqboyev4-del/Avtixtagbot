/**
 * Markazlashtirilgan matnlar va admin tugmalari.
 * Bu yerdan o'zgartirsangiz — barcha joyda yangilanadi.
 */

const ADMIN_USERNAME = '@id_uzzz';

const payment = {
    pending: (name, adminUsername = ADMIN_USERNAME) =>
        `👋 Assalomu alaykum, Hurmatli ${name}!\n\n` +
        `⚠ Siz botdan foydalanish uchun botning oylik tulovini amalga oshirmagansiz.\n` +
        `⚠ Botdan foydalanish uchun admin orqali to'lov qiling!!!\n\n` +
        `👨‍💼 Admin: ${adminUsername}`,

    blocked: (adminUsername = ADMIN_USERNAME) =>
        `⚠ Sizning foydalanish muddatingiz tugagan.\n` +
        `Botdan foydalanishni davom ettirish uchun to'lovni amalga oshiring va botni qayta ishga tushiring.\n\n` +
        `👨‍💼 Admin: ${adminUsername}`,

    expired: (adminUsername = ADMIN_USERNAME) =>
        `⚠️ **Foydalanish muddatingiz tugadi!**\n\n` +
        `Botdan foydalanishni davom ettirish uchun to'lovni amalga oshiring.\n\n` +
        `👨‍💼 Admin: ${adminUsername}`,

    expiryWarning: (adminUsername = ADMIN_USERNAME) =>
        `⚠️ **Diqqat!**\n\n` +
        `Sizning botdan foydalanish muddatingiz tugashiga **1 kun** qoldi. Botdan foydalanishni davom ettirish uchun to'lovni amalga oshiring.\n\n` +
        `👨‍💼 Admin: ${adminUsername}`
};

const errors = {
    botLoading: '⏳ Bot hali yuklanmoqda. Iltimos, 10 soniyadan keyin qayta /start bosing.'
};

// Admin tasdiqlash/bloklash tugmalari (texts.adminButtons)
// Bu tugmalar BTN helperi orqali yasaladi — premium emoji va rang bilan.
const { BTN, BUTTON_EMOJI_IDS, BUTTON_STYLES } = require('./helpers');

const adminButtons = {
    approve1Month: (chatId) => BTN("✅ 1 Oy",     `admin_approve_1month_${chatId}`, { iconId: BUTTON_EMOJI_IDS.check,  style: BUTTON_STYLES.success }),
    approveVIP:    (chatId) => BTN("👑 VIP",      `admin_approve_vip_${chatId}`,    { iconId: BUTTON_EMOJI_IDS.crown,  style: BUTTON_STYLES.success }),
    approveCustom: (chatId) => BTN("✍️ Ixtiyoriy", `admin_approve_${chatId}`,        { iconId: BUTTON_EMOJI_IDS.custom, style: BUTTON_STYLES.primary }),
    block:         (chatId) => BTN("🚫 Bloklash", `admin_block_${chatId}`,          { iconId: BUTTON_EMOJI_IDS.block,  style: BUTTON_STYLES.danger }),
    contactAdmin:  (adminUsername = ADMIN_USERNAME) => BTN(
        "👨‍💼 Admin bilan bog'lanish",
        null,
        { url: `https://t.me/${adminUsername.replace('@', '')}`, iconId: BUTTON_EMOJI_IDS.admin, style: BUTTON_STYLES.primary }
    )
};

module.exports = {
    ADMIN_USERNAME,
    payment,
    errors,
    adminButtons,
    admin: { username: ADMIN_USERNAME }
};

const User = require('../models/User');

// Har bir funksiya uchun alohida limitlar (xohlagan raqamingizni qo'yishingiz mumkin)
const LIMITS = {
    utag: 2000,
    reklama: 30 // Masalan, reklama uchun 10 ta qildik
};

const getTodayKey = () => new Date().toISOString().slice(0, 10);

const getDailyUsage = async (chatId, feature) => {
    const user = await User.findOne({ where: { chatId } });
    if (!user) throw new Error('Foydalanuvchi topilmadi.');

    const countField = feature === 'utag' ? 'utagDailyCount' : 'reklamaDailyCount';
    const dateField = feature === 'utag' ? 'utagDailyDate' : 'reklamaDailyDate';
    const today = getTodayKey();

    if (user[dateField] !== today || !Number.isInteger(user[countField])) {
        await User.update({ [countField]: 0, [dateField]: today }, { where: { chatId } });
        return 0;
    }

    return user[countField];
};

const incrementDailyUsage = async (chatId, feature) => {
    const countField = feature === 'utag' ? 'utagDailyCount' : 'reklamaDailyCount';
    const dateField = feature === 'utag' ? 'utagDailyDate' : 'reklamaDailyDate';
    const today = getTodayKey();
    const current = await getDailyUsage(chatId, feature);

    // Tanlangan funksiyaning o'z limitini olamiz
    const limit = LIMITS[feature] || 20;

    if (current >= limit) return false;

    await User.update(
        { [countField]: current + 1, [dateField]: today },
        { where: { chatId } }
    );
    return true;
};

const getRemainingDailyUsage = async (chatId, feature) => {
    const limit = LIMITS[feature] || 20;
    const usage = await getDailyUsage(chatId, feature);
    return Math.max(0, limit - usage);
};

module.exports = {
    LIMITS,
    getTodayKey,
    getDailyUsage,
    incrementDailyUsage,
    getRemainingDailyUsage
};
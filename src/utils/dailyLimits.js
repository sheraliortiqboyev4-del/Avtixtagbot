const User = require('../models/User');

const DAILY_LIMIT = 20;

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

    if (current >= DAILY_LIMIT) return false;
    await User.update(
        { [countField]: current + 1, [dateField]: today },
        { where: { chatId } }
    );
    return true;
};

const getRemainingDailyUsage = async (chatId, feature) => {
    return Math.max(0, DAILY_LIMIT - await getDailyUsage(chatId, feature));
};

module.exports = {
    DAILY_LIMIT,
    getTodayKey,
    getDailyUsage,
    incrementDailyUsage,
    getRemainingDailyUsage
};

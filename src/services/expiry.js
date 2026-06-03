const { Op } = require('sequelize');
const User = require('../models/User');
const { blockExpiredUser } = require('./userbot');
const { triggerBackup } = require('../utils/dbBackup');

/** Muddat o'tgan, lekin hali approved bo'lganlar (zaxiradan tiklanganda ham) */
const findExpiredApprovedUsers = async () => {
    const now = new Date();
    return User.findAll({
        where: {
            status: 'approved',
            expireAt: {
                [Op.ne]: null,
                [Op.lt]: now
            }
        }
    });
};

/**
 * Barcha muddati o'tganlarni bloklaydi.
 * Ishga tushganda (zaxira tiklangach) va har 60 soniyada chaqiriladi.
 */
const runExpirySweep = async (bot, options = {}) => {
    const { reason = 'periodic', backupOnChange = true } = options;

    const expired = await findExpiredApprovedUsers();
    if (!expired.length) return 0;

    const now = new Date();
    let blocked = 0;

    for (const row of expired) {
        const user = await User.findOne({ where: { chatId: row.chatId } });
        if (!user || user.status !== 'approved' || !user.expireAt) continue;
        if (new Date(user.expireAt) >= now) continue;

        await blockExpiredUser(user, bot, { skipBackup: true });
        blocked++;
    }

    if (blocked > 0) {
        console.log(`[ExpirySweep/${reason}] ${blocked} ta foydalanuvchi bloklandi`);
        if (backupOnChange) {
            triggerBackup(`muddat_tugadi_${reason}`, true);
        }
    }

    return blocked;
};

module.exports = { runExpirySweep, findExpiredApprovedUsers };

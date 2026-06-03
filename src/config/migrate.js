const migrateChannelUrls = async () => {
    const { normalizeTelegramUrl } = require('../utils/helpers');
    const Channel = require('../models/Channel');
    const channels = await Channel.findAll();
    for (const ch of channels) {
        const fixed = normalizeTelegramUrl(ch.url);
        if (fixed && fixed !== ch.url) {
            await Channel.update({ url: fixed }, { where: { id: ch.id } });
            console.log(`✅ Migration: kanal URL yangilandi — ${ch.name}`);
        }
    }
};

const migrateSchema = async () => {
    const { loadModels } = require('./db');
    loadModels();
    const { sequelize } = require('./db');
    await sequelize.sync();
    await migrateChannelUrls();
};

const isMissingColumnError = (err) => {
    const msg = `${err?.message || ''} ${err?.parent?.message || ''} ${err?.original?.message || ''}`;
    return msg.includes('no such column');
};

const withMigrationRetry = async (fn) => {
    try {
        return await fn();
    } catch (e) {
        if (!isMissingColumnError(e)) throw e;
        console.log('⚠️ Ustun topilmadi — migratsiya qayta ishga tushirilmoqda...');
        await migrateSchema();
        return await fn();
    }
};

module.exports = {
    migrateSchema,
    isMissingColumnError,
    withMigrationRetry
};

const { DataTypes } = require('sequelize');

/** Eski SQLite bazaga yangi ustunlarni qo'shish (sequelize.sync ALTER qilmaydi) */
const USER_COLUMNS = {
    coins: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    referrerChatId: { type: DataTypes.BIGINT, allowNull: true },
    referralEligible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    referralToken: { type: DataTypes.STRING, allowNull: true },
    referralTokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
    coinRedemptions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
};

const migrateUsersTable = async () => {
    const { sequelize } = require('./db');
    const qi = sequelize.getQueryInterface();

    let description;
    try {
        description = await qi.describeTable('users');
    } catch (e) {
        console.log('Migration: users jadvali hali yo\'q (sync yaratadi)');
        return false;
    }

    let changed = false;
    for (const [name, attributes] of Object.entries(USER_COLUMNS)) {
        if (description[name]) continue;
        try {
            await qi.addColumn('users', name, attributes);
            console.log(`✅ Migration: users.${name} qo'shildi`);
            description[name] = attributes;
            changed = true;
        } catch (e) {
            if (e.message && e.message.includes('duplicate column')) {
                console.log(`Migration: users.${name} allaqachon mavjud`);
            } else {
                console.error(`❌ Migration xatosi (users.${name}):`, e.message);
                throw e;
            }
        }
    }

    if (description.referralToken) {
        try {
            await sequelize.query(
                'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_token ON users(referralToken) WHERE referralToken IS NOT NULL'
            );
        } catch (e) {
            // indeks mavjud
        }
    }

    return changed;
};

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
    await migrateUsersTable();
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
    migrateUsersTable,
    isMissingColumnError,
    withMigrationRetry
};

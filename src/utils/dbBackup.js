const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const config = require('../config');
const { sequelize } = require('../config/db');
const sqlite3 = require('sqlite3');
const { encryptBuffer, decryptBuffer } = require('./backupCrypto');

const DB_PATH = path.join(__dirname, '../../database.sqlite');
const BACKUP_FILENAME_ENC = 'avtobot_db_backup.enc';
const BACKUP_FILENAME_LEGACY = 'avtobot_db_backup.sqlite';
const MIN_DB_BYTES = 8192;
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 8000;

let backupClient = null;
let backupInProgress = false;
let lastBackupAt = 0;
let debounceTimer = null;

const initBackupClient = async () => {
    if (!config.apiId || !config.apiHash) {
        console.log('⚠️ Backup: API_ID / API_HASH topilmadi');
        return null;
    }

    const adminSession = process.env.ADMIN_SESSION;
    if (!adminSession) {
        console.log('⚠️ Backup: ADMIN_SESSION .env da topilmadi');
        return null;
    }

    if (backupClient) return backupClient;

    try {
        backupClient = new TelegramClient(
            new StringSession(adminSession.trim()),
            config.apiId,
            config.apiHash,
            {
                connectionRetries: 5,
                requestRetries: 3,
                timeout: 60000,
                autoReconnect: true
            }
        );
        await backupClient.connect();
        console.log('✅ Backup client (ADMIN_SESSION) ulandi');
        return backupClient;
    } catch (error) {
        console.error('❌ Backup client ulanish xatosi:', error.message);
        backupClient = null;
        return null;
    }
};

const hasUsersTable = () => new Promise((resolve) => {
    if (!fs.existsSync(DB_PATH)) return resolve(false);
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
        if (err) return resolve(false);
        db.get(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
            [],
            (e, row) => {
                db.close();
                resolve(!!row);
            }
        );
    });
});

const findNewestBackupMessage = async (client, fileName) => {
    try {
        const messages = await client.getMessages('me', { limit: 100 });
        let newest = null;
        for (const msg of messages) {
            if (!msg.document || !msg.document.attributes) continue;
            for (const attr of msg.document.attributes) {
                if (attr.fileName === fileName) {
                    const msgId = Number(msg.id);
                    if (!newest || msgId > Number(newest.id)) newest = msg;
                }
            }
        }
        return newest;
    } catch (error) {
        console.error(`❌ Zaxira qidirish xatosi (${fileName}):`, error.message);
        return null;
    }
};

const findBackupMessage = (client, fileName) => findNewestBackupMessage(client, fileName);

const deleteBackupMessage = async (client, fileName) => {
    const oldBackup = await findBackupMessage(client, fileName);
    if (!oldBackup) return;
    try {
        const msgId = Number(oldBackup.id);
        await client.invoke(
            new Api.messages.DeleteMessages({
                id: [msgId],
                revoke: false
            })
        );
        console.log(`🗑 Eski zaxira o'chirildi: ${fileName}`);
    } catch (e) {
        // O'chirilmasa ham yangi zaxira yuboriladi; restore eng yangisini topadi
        console.log(`🗑 Eski zaxira o'chirilmadi (${fileName}, e'tiborsiz): ${e.message}`);
    }
};

const needsRestore = () => {
    if (!fs.existsSync(DB_PATH)) return true;
    try {
        const stats = fs.statSync(DB_PATH);
        return stats.size < MIN_DB_BYTES;
    } catch (e) {
        return true;
    }
};

const readStatsFromFile = () => new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
        if (err) return reject(err);
        db.get(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN session IS NOT NULL AND session != '' THEN 1 ELSE 0 END) AS withSession,
                COALESCE(SUM(clicks), 0) AS totalClicks,
                COALESCE(SUM(utagCount), 0) AS totalUtag,
                COALESCE(SUM(reydCount), 0) AS totalReyd,
                COALESCE(SUM(usersGathered), 0) AS totalGathered,
                COALESCE(SUM(adsCount), 0) AS totalAds
            FROM users`,
            [],
            (queryErr, row) => {
                db.close();
                if (queryErr) return reject(queryErr);
                resolve(row || {});
            }
        );
    });
});

const buildBackupCaption = async (reason) => {
    const lines = [
        '🤖 AvtoBot Pro — shifrlangan zaxira',
        `📅 ${new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}`,
        `📌 Sabab: ${reason}`
    ];

    try {
        if (fs.existsSync(DB_PATH)) {
            const s = await readStatsFromFile();
            lines.push(
                '',
                `👥 Jami: ${s.total || 0} | ✅ ${s.approved || 0} | ⏳ ${s.pending || 0} | 🚫 ${s.blocked || 0}`,
                `🔐 Sessiyali: ${s.withSession || 0}`,
                `💎 Almaz: ${s.totalClicks || 0} | 🏷 Utag: ${s.totalUtag || 0}`,
                `⚔️ Reyd: ${s.totalReyd || 0} | 👥 Scrape: ${s.totalGathered || 0} | 📢 Rek: ${s.totalAds || 0}`
            );
        }
    } catch (e) {
        lines.push('', `ℹ️ Statistika o'qilmadi: ${e.message}`);
    }

    return lines.join('\n');
};

const downloadAndRestore = async (client, msg, encrypted) => {
    const buffer = await client.downloadMedia(msg.document);
    const dbBuffer = encrypted ? decryptBuffer(buffer) : buffer;

    if (dbBuffer.length < MIN_DB_BYTES) {
        console.error('❌ Zaxira fayli juda kichik, tiklanmadi');
        return false;
    }

    fs.writeFileSync(DB_PATH, dbBuffer);

    try {
        await sequelize.authenticate();
        const { migrateSchema } = require('../config/migrate');
        await migrateSchema();
        console.log('✅ Tiklangan baza migratsiya qilindi');
    } catch (e) {
        console.error('⚠️ Tiklangan baza migratsiyasi (connectDB da qayta uriniladi):', e.message);
    }

    if (!(await hasUsersTable())) {
        console.error('❌ Tiklangan faylda users jadvali yo\'q — bekor qilindi');
        try { fs.unlinkSync(DB_PATH); } catch (e) {}
        return false;
    }

    console.log(`✅ Bazadan tiklandi (${encrypted ? 'shifrlangan' : 'legacy'}, ${dbBuffer.length} bayt)`);
    return true;
};

const restoreDB = async (options = {}) => {
    const { force = false } = options;

    try {
        if (!force && !needsRestore()) {
            console.log('📂 Mahalliy database.sqlite mavjud — restore o\'tkazilmadi');
            return false;
        }

        console.log('📥 Telegram Saved Messages dan zaxira tiklanmoqda...');
        const client = await initBackupClient();
        if (!client) return false;

        const encMsg = await findNewestBackupMessage(client, BACKUP_FILENAME_ENC);
        if (encMsg) {
            const ok = await downloadAndRestore(client, encMsg, true);
            if (ok) return true;
        }

        const legacyMsg = await findNewestBackupMessage(client, BACKUP_FILENAME_LEGACY);
        if (legacyMsg) {
            console.log('📥 Legacy (.sqlite) zaxira topildi, tiklanmoqda...');
            return await downloadAndRestore(client, legacyMsg, false);
        }

        console.log('⚠️ Saved Messages da zaxira topilmadi');
        return false;
    } catch (error) {
        console.error('❌ Restore xatosi:', error.message);
        return false;
    }
};

/** true faqat fayl qayta yozilib, sequelize qayta ulash kerak bo'lsa */
const verifyDatabaseAfterConnect = async () => {
    try {
        if (!(await hasUsersTable())) {
            console.log('⚠️ users jadvali yo\'q — majburiy restore...');
            return await restoreDB({ force: true });
        }

        const { migrateSchema, withMigrationRetry } = require('../config/migrate');
        const User = require('../models/User');
        await migrateSchema();
        const count = await withMigrationRetry(() => User.count());
        if (count > 0) return false;

        console.log('⚠️ Bazada foydalanuvchi yo\'q — majburiy restore...');
        return await restoreDB({ force: true });
    } catch (e) {
        console.error('❌ Bazani tekshirish xatosi:', e.message);
        if (e.message && e.message.includes('no such table')) {
            return await restoreDB({ force: true });
        }
        return false;
    }
};

const backupDB = async (reason = 'manual') => {
    if (backupInProgress) {
        console.log('⏳ Zaxira allaqachon ketmoqda, o\'tkazildi');
        return false;
    }

    if (!fs.existsSync(DB_PATH)) {
        console.log('⚠️ Zaxira: database.sqlite topilmadi');
        return false;
    }

    backupInProgress = true;

    try {
        const stats = fs.statSync(DB_PATH);
        if (stats.size < 512) {
            console.log('⚠️ Zaxira: DB juda kichik, o\'tkazildi');
            return false;
        }

        if (!(await hasUsersTable())) {
            console.log('⚠️ Zaxira: users jadvali yo\'q, o\'tkazildi');
            return false;
        }

        try {
            await sequelize.query('PRAGMA wal_checkpoint(FULL)');
        } catch (e) {}

        const plainBuffer = fs.readFileSync(DB_PATH);
        let encryptedBuffer;
        try {
            encryptedBuffer = encryptBuffer(plainBuffer);
        } catch (e) {
            console.error('❌ Zaxirani shifrlash xatosi:', e.message);
            return false;
        }

        const client = await initBackupClient();
        if (!client) return false;

        await deleteBackupMessage(client, BACKUP_FILENAME_ENC);
        await deleteBackupMessage(client, BACKUP_FILENAME_LEGACY);

        const caption = await buildBackupCaption(reason);
        const tmpPath = path.join(__dirname, '../../temp_backup_upload.enc');
        const tempDir = path.dirname(tmpPath);
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(tmpPath, encryptedBuffer);

        await client.sendFile('me', {
            file: tmpPath,
            caption,
            attributes: [
                new Api.DocumentAttributeFilename({ fileName: BACKUP_FILENAME_ENC })
            ]
        });

        try { fs.unlinkSync(tmpPath); } catch (e) {}

        lastBackupAt = Date.now();
        console.log(`✅ Zaxira yangilandi (${reason}) — ${encryptedBuffer.length} bayt shifrlangan`);
        return true;
    } catch (error) {
        console.error('❌ Backup xatosi:', error.message);
        return false;
    } finally {
        backupInProgress = false;
    }
};

const triggerBackup = (reason = 'event', force = false) => {
    const run = () => {
        if (!force && Date.now() - lastBackupAt < DEBOUNCE_MS) {
            return;
        }
        backupDB(reason).catch((e) => console.error('triggerBackup:', e.message));
    };

    if (force) {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        run();
        return;
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, 2000);
};

const startBackupScheduler = () => {
    setInterval(() => {
        triggerBackup('har_10_daqiqa', true);
    }, BACKUP_INTERVAL_MS);
    console.log(`📤 Avto-zaxira: har ${BACKUP_INTERVAL_MS / 60000} daqiqada yangilanadi`);
};

module.exports = {
    restoreDB,
    backupDB,
    triggerBackup,
    verifyDatabaseAfterConnect,
    startBackupScheduler,
    needsRestore
};

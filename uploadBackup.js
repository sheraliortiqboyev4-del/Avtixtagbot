/**
 * Qo'lda zaxira yuklash (ADMIN_SESSION va BACKUP_SECRET .env da bo'lishi kerak)
 * Ishga tushirish: node uploadBackup.js
 */
require('dotenv').config();
const { backupDB } = require('./src/utils/dbBackup');
const { sequelize, connectDB } = require('./src/config/db');

const run = async () => {
    try {
        await connectDB();
        const ok = await backupDB('qo_lda');
        await sequelize.close();
        process.exit(ok ? 0 : 1);
    } catch (error) {
        console.error('❌', error.message);
        process.exit(1);
    }
};

run();

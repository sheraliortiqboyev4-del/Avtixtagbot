const { Sequelize } = require('sequelize');
const path = require('path');

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(__dirname, '../../database.sqlite'),
    logging: false
});

let dbReady = false;

const setDbReady = (ready) => {
    dbReady = !!ready;
};

const getDbReady = () => dbReady;

const loadModels = () => {
    require('../models/User');
    require('../models/Channel');
    require('../models/PremiumAd');
    require('../models/BotSetting');
    require('../models/Referral');
    require('../models/CoinTransaction');
};

const connectDB = async () => {
    loadModels();
    await sequelize.authenticate();
    console.log('✅ SQLite ulanishi muvaffaqiyatli.');
    const { migrateSchema } = require('./migrate');
    await migrateSchema();
    console.log('✅ Ma\'lumotlar bazasi sinxronizatsiya va migratsiya tugadi.');
    const { ensureBonusSettingSeed } = require('../services/bonus');
    await ensureBonusSettingSeed();
    setDbReady(true);
};

const reconnectDB = async () => {
    setDbReady(false);
    try {
        await sequelize.close();
    } catch (e) {
        // allaqachon yopilgan bo'lishi mumkin
    }
    await connectDB();
};

const ensureSchema = async () => {
    loadModels();
    await sequelize.sync();
    const { migrateSchema } = require('./migrate');
    await migrateSchema();
};

module.exports = { sequelize, connectDB, reconnectDB, ensureSchema, setDbReady, getDbReady, loadModels };

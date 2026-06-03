const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const BotSetting = sequelize.define('BotSetting', {
    key: {
        type: DataTypes.STRING,
        primaryKey: true
    },
    value: {
        type: DataTypes.STRING,
        allowNull: false
    }
}, {
    tableName: 'bot_settings',
    timestamps: false
});

module.exports = BotSetting;

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const PremiumAd = sequelize.define('PremiumAd', {
    chatId: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: true,
        primaryKey: true
    },
    content: {
        type: DataTypes.JSON,
        allowNull: false
    },
    usersList: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'pending'
    },
    createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'premium_ads',
    timestamps: false
});

module.exports = PremiumAd;

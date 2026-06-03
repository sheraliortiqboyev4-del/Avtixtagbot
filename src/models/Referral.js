const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Referral = sequelize.define('Referral', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    referrerChatId: {
        type: DataTypes.BIGINT,
        allowNull: false
    },
    referredChatId: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: true
    },
    linkToken: {
        type: DataTypes.STRING,
        allowNull: true
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'registered' // registered | rewarded
    },
    createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    },
    rewardedAt: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'referrals',
    timestamps: false
});

module.exports = Referral;

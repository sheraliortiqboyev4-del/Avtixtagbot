const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const User = sequelize.define('User', {
    chatId: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: true,
        primaryKey: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    username: {
        type: DataTypes.STRING,
        allowNull: true
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'pending' // approved, blocked, pending
    },
    subscriptionType: {
        type: DataTypes.STRING,
        defaultValue: 'free' // monthly, vip, free, expired
    },
    session: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null
    },
    reydAccounts: {
        type: DataTypes.JSON,
        defaultValue: []
    },
    reklamaAccounts: {
        type: DataTypes.JSON,
        defaultValue: []
    },
    expireAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null
    },
    avtoAlmaz: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    expiryWarningSent: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    clicks: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    reydCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    usersGathered: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    adsCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    utagCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    utagAccountMode: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: null // null, 'main', or 'all'
    },
    utagHistory: {
        type: DataTypes.JSON,
        defaultValue: []
    },
    joinedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'users',
    timestamps: false
});

module.exports = User;

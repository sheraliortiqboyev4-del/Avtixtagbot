const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const CoinTransaction = sequelize.define('CoinTransaction', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    chatId: {
        type: DataTypes.BIGINT,
        allowNull: false
    },
    amount: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    type: {
        type: DataTypes.STRING,
        allowNull: false
    },
    meta: {
        type: DataTypes.JSON,
        allowNull: true
    },
    createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'coin_transactions',
    timestamps: false
});

module.exports = CoinTransaction;

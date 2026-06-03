const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Channel = sequelize.define('Channel', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    channelId: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    url: {
        type: DataTypes.STRING,
        allowNull: false
    }
}, {
    tableName: 'channels',
    timestamps: false
});

module.exports = Channel;

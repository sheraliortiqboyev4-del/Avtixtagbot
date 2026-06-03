const User = require('../models/User');
const { withMigrationRetry } = require('../config/migrate');

const findUserByChatId = (chatId) =>
    withMigrationRetry(() => User.findOne({ where: { chatId } }));

module.exports = { findUserByChatId };

const crypto = require('crypto');
const { Op } = require('sequelize');
const User = require('../models/User');
const Referral = require('../models/Referral');
const BotSetting = require('../models/BotSetting');
const CoinTransaction = require('../models/CoinTransaction');
const { triggerBackup } = require('../utils/dbBackup');
const { escapeHTML } = require('../utils/helpers');
const config = require('../config');

const COINS_PER_MONTH = 50;
const REFERRAL_LINK_MS = 5 * 24 * 60 * 60 * 1000;
const SETTING_KEY = 'bonus_system_enabled';

const getReferralBotUsername = () => {
    const fromEnv = process.env.REFERRAL_BOT_USERNAME;
    if (fromEnv) return fromEnv.replace(/^@/, '').trim();
    const fromConfig = config.botPromoUsername;
    if (fromConfig) return fromConfig.replace(/^@/, '').trim();
    return 'Foydasizku_bot';
};

const isBonusEnabled = async () => {
    const row = await BotSetting.findByPk(SETTING_KEY);
    if (!row) return true;
    return row.value === 'true' || row.value === '1';
};

const setBonusEnabled = async (enabled) => {
    await BotSetting.upsert({
        key: SETTING_KEY,
        value: enabled ? 'true' : 'false'
    });
    triggerBackup('bonus_toggle', true);
};

const ensureBonusSettingSeed = async () => {
    const row = await BotSetting.findByPk(SETTING_KEY);
    if (!row) {
        await BotSetting.create({ key: SETTING_KEY, value: 'true' });
    }
};

const generateToken = () => crypto.randomBytes(6).toString('hex');

const isTokenValid = (user) => {
    if (!user.referralToken || !user.referralTokenExpiresAt) return false;
    return new Date(user.referralTokenExpiresAt) > new Date();
};

const refreshReferralToken = async (chatId) => {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + REFERRAL_LINK_MS);
    await User.update(
        { referralToken: token, referralTokenExpiresAt: expiresAt },
        { where: { chatId } }
    );
    return { token, expiresAt };
};

const ensureReferralToken = async (chatId) => {
    const user = await User.findOne({ where: { chatId } });
    if (!user) return null;
    if (isTokenValid(user)) {
        return { token: user.referralToken, expiresAt: user.referralTokenExpiresAt };
    }
    return refreshReferralToken(chatId);
};

const buildReferralLink = async (bot, chatId) => {
    const username = getReferralBotUsername();
    const { token } = await ensureReferralToken(chatId);
    return `https://t.me/${username}?start=ref_${token}`;
};

const parseStartPayload = (text) => {
    if (!text) return null;
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const payload = parts[1];
    if (payload.startsWith('ref_')) {
        return payload.slice(4);
    }
    return null;
};

const recordCoinTx = async (chatId, amount, type, meta = null) => {
    await CoinTransaction.create({ chatId, amount, type, meta });
};

const handleStartWithReferral = async (bot, chatId, name, username, payloadToken, isNewUser) => {
    if (!await isBonusEnabled()) return null;
    if (!payloadToken || !isNewUser) return null;

    const referrer = await User.findOne({
        where: {
            referralToken: payloadToken,
            referralTokenExpiresAt: { [Op.gt]: new Date() }
        }
    });

    if (!referrer) {
        return { invalidLink: true };
    }

    if (referrer.chatId.toString() === chatId.toString()) {
        return { selfReferral: true };
    }

    await User.update(
        {
            referrerChatId: referrer.chatId,
            referralEligible: true
        },
        { where: { chatId } }
    );

    await Referral.create({
        referrerChatId: referrer.chatId,
        referredChatId: chatId,
        linkToken: payloadToken,
        status: 'registered'
    });

    const referredName = name || username || chatId;
    const referrerText =
        `🆕 **Yangi Referral!**\n\n` +
        `👤 **${referredName}** sizning referral havolangiz orqali ro'yxatdan o'tdi.\n\n` +
        `📢 U kanallarga obuna bo'lgandan keyin sizga **+1 coin** qo'shiladi.\n\n` +
        `🪙 Jami coinlar: **${referrer.coins || 0}**`;

    try {
        await bot.sendMessage(referrer.chatId, referrerText, { parse_mode: 'Markdown', skipEmojiWrap: true });
    } catch (e) {
        console.error('Referrer notify error:', e.message);
    }

    return { referrerChatId: referrer.chatId };
};

const processSubscriptionReferralReward = async (bot, referredChatId) => {
    if (!await isBonusEnabled()) return false;

    const referred = await User.findOne({ where: { chatId: referredChatId } });
    if (!referred || !referred.referrerChatId || !referred.referralEligible) return false;

    const referral = await Referral.findOne({
        where: { referredChatId, status: 'registered' }
    });
    if (!referral) return false;

    const referrerChatId = referred.referrerChatId;
    if (referrerChatId.toString() === referredChatId.toString()) return false;

    const referrer = await User.findOne({ where: { chatId: referrerChatId } });
    if (!referrer) return false;

    const newCoins = (referrer.coins || 0) + 1;
    await User.update({ coins: newCoins }, { where: { chatId: referrerChatId } });
    await Referral.update(
        { status: 'rewarded', rewardedAt: new Date() },
        { where: { id: referral.id } }
    );
    await recordCoinTx(referrerChatId, 1, 'referral_reward', { referredChatId });

    triggerBackup('referral_coin', true);

    const referredLabel = referred.name || referred.username || referredChatId;

    try {
        await bot.sendMessage(
            referrerChatId,
            `✅ **+1 coin hisobingizga qo'shildi!**\n\n` +
            `🪙 Jami coinlar: **${newCoins}**`,
            { parse_mode: 'Markdown', skipEmojiWrap: true }
        );
    } catch (e) {}

    // try {
    //     await bot.sendMessage(
    //         referredChatId,
    //         `✅ Kanallarga obuna bo'ldingiz!\n\nReferreringizga **+1 coin** berildi. Rahmat!`,
    //         { skipEmojiWrap: true }
    //     );
    // } catch (e) {}

    return true;
};

const getUserReferralStats = async (chatId) => {
    const invited = await Referral.count({ where: { referrerChatId: chatId } });
    const rewarded = await Referral.count({
        where: { referrerChatId: chatId, status: 'rewarded' }
    });
    const pending = invited - rewarded;
    const user = await User.findOne({ where: { chatId } });
    return {
        coins: user?.coins || 0,
        invited,
        rewarded,
        pending,
        redemptions: user?.coinRedemptions || 0
    };
};

const buildBonusMessage = async (bot, chatId) => {
    const parseMode = 'Markdown';
    const enabled = await isBonusEnabled();
    if (!enabled) {
        return {
            text: '⏸ **Bonus tizimi vaqtincha o\'chirilgan.**\n\nKeyinroq qayta urinib ko\'ring.',
            keyboard: { inline_keyboard: [[{ text: '🔙 Orqaga', callback_data: 'menu_back_main' }]] },
            parseMode
        };
    }

    const stats = await getUserReferralStats(chatId);
    const link = await buildReferralLink(bot, chatId);
    const user = await User.findOne({ where: { chatId } });
    const expires = user?.referralTokenExpiresAt
        ? new Date(user.referralTokenExpiresAt).toLocaleDateString('uz-UZ')
        : '—';

    const shareText = encodeURIComponent("Menga bu bot juda yoqdi! Siz ham bu havola orqali kirib, 50 coin bilan 1 oylik obuna olishingiz mumkin!");
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link || '')}&text=${shareText}`;

    const text =
        `🎁 **Bonus / Referral**\n\n` +
        `🪙 **Coinlar:** ${stats.coins} ta\n` +
        `👥 **Taklif qilganlar:** ${stats.invited} ta\n` +
        `⏳ **Kutilmoqda (obuna):** ${stats.pending} ta\n\n` +
        `🔗 **Havola** (5 kun amal qiladi, muddati: ${expires}):\n` +
        `\`${link || 'Havola yaratilmadi'}\`\n\n` +
        `**Faqat yangi** foydalanuvchi havolangiz bilan kirsa va kanallarga obuna bo'lsa — **+1 coin**.\n` +
        `💰 1 oylik obuna **${COINS_PER_MONTH} coin**`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '🔄 Yangi havola yaratish', callback_data: 'bonus_new_link' }],
            [{ text: '👥 Do\'stlarga ulashish', url: shareUrl }],
            [{ text: '🔙 Orqaga', callback_data: 'menu_back_main' }]
        ]
    };

    return { text, keyboard, link, parseMode };
};

const buildCoinMessage = async (chatId) => {
    const enabled = await isBonusEnabled();
    const user = await User.findOne({ where: { chatId } });
    const coins = user?.coins || 0;
    const need = Math.max(0, COINS_PER_MONTH - coins);

    if (!enabled) {
        return {
            text: '⏸ **Bonus tizimi o\'chirilgan.** Coin ishlatib bo\'lmaydi.',
            keyboard: { inline_keyboard: [[{ text: '🔙 Orqaga', callback_data: 'menu_back_main' }]] }
        };
    }

    const text =
        `🪙 **Coinlar**\n\n` +
        `💰 Jami: **${coins}** coin\n` +
        `🎯 1 oylik obuna: **${COINS_PER_MONTH}** coin\n` +
        `📉 Yana kerak: **${need}** coin\n\n` +
        `Do'stlaringizni taklif qiling (/bonus) — har biri kanalga obuna bo'lgach **+1 coin**.`;

    const buttons = [];
    if (coins >= COINS_PER_MONTH) {
        buttons.push([{ text: `✅ 1 oylik obunani sotib olish (${COINS_PER_MONTH} coin)`, callback_data: 'coin_redeem_month' }]);
    }
    buttons.push([{ text: '🔙 Orqaga', callback_data: 'menu_back_main' }]);

    return { text, keyboard: { inline_keyboard: buttons } };
};

const redeemCoinsForMonth = async (bot, chatId) => {
    if (!await isBonusEnabled()) {
        throw new Error('Bonus tizimi o\'chirilgan');
    }

    const user = await User.findOne({ where: { chatId } });
    if (!user) throw new Error('Foydalanuvchi topilmadi');
    if ((user.coins || 0) < COINS_PER_MONTH) {
        throw new Error(`Kamida ${COINS_PER_MONTH} coin kerak`);
    }

    const now = new Date();
    let expireAt = now;
    if (user.expireAt && new Date(user.expireAt) > now) {
        expireAt = new Date(user.expireAt);
    }
    expireAt = new Date(expireAt.getTime() + 30 * 24 * 60 * 60 * 1000);

    const newCoins = user.coins - COINS_PER_MONTH;
    await User.update(
        {
            coins: newCoins,
            status: 'approved',
            subscriptionType: 'Coin (Bonus)',
            expireAt,
            expiryWarningSent: false,
            coinRedemptions: (user.coinRedemptions || 0) + 1
        },
        { where: { chatId } }
    );

    await recordCoinTx(chatId, -COINS_PER_MONTH, 'redeem_month', { expireAt });
    triggerBackup('coin_redeem', true);

    return { newCoins, expireAt };
};

const getAdminBonusStats = async () => {
    const enabled = await isBonusEnabled();
    const totalCoins = await User.sum('coins') || 0;
    const totalReferrals = await Referral.count();
    const rewardedReferrals = await Referral.count({ where: { status: 'rewarded' } });
    const totalRedemptions = await User.sum('coinRedemptions') || 0;
    const usersWithCoins = await User.count({ where: { coins: { [Op.gt]: 0 } } });

    return {
        enabled,
        totalCoins,
        totalReferrals,
        rewardedReferrals,
        pendingReferrals: totalReferrals - rewardedReferrals,
        totalRedemptions,
        usersWithCoins
    };
};

const getTop10Referrers = async () => {
    const rows = await Referral.findAll({
        attributes: [
            'referrerChatId',
            [Referral.sequelize.fn('COUNT', Referral.sequelize.col('id')), 'total']
        ],
        group: ['referrerChatId'],
        order: [[Referral.sequelize.fn('COUNT', Referral.sequelize.col('id')), 'DESC']],
        limit: 10,
        raw: true
    });

    const result = [];
    for (const row of rows) {
        const referrerChatId = row.referrerChatId;
        const rewarded = await Referral.count({
            where: { referrerChatId, status: 'rewarded' }
        });
        const u = await User.findOne({ where: { chatId: referrerChatId } });
        result.push({
            chatId: referrerChatId,
            name: u?.name || 'Noma\'lum',
            username: u?.username,
            coins: u?.coins || 0,
            total: parseInt(row.total, 10) || 0,
            rewarded
        });
    }
    result.sort((a, b) => b.rewarded - a.rewarded || b.coins - a.coins);
    return result;
};

const getCoinRedeemers = async (limit = 20) => {
    return User.findAll({
        where: { coinRedemptions: { [Op.gt]: 0 } },
        order: [['coinRedemptions', 'DESC']],
        limit
    });
};

const adminAdjustCoins = async (targetChatId, delta, adminChatId) => {
    const user = await User.findOne({ where: { chatId: targetChatId } });
    if (!user) throw new Error('Foydalanuvchi topilmadi');

    const newCoins = Math.max(0, (user.coins || 0) + delta);
    await User.update({ coins: newCoins }, { where: { chatId: targetChatId } });
    await recordCoinTx(targetChatId, delta, delta >= 0 ? 'admin_add' : 'admin_sub', { adminChatId });
    triggerBackup('admin_coin_adjust', true);

    return { newCoins, delta };
};

const adminSetCoins = async (targetChatId, amount, adminChatId) => {
    const user = await User.findOne({ where: { chatId: targetChatId } });
    if (!user) throw new Error('Foydalanuvchi topilmadi');

    const oldCoins = user.coins || 0;
    const newCoins = Math.max(0, parseInt(amount, 10) || 0);
    await User.update({ coins: newCoins }, { where: { chatId: targetChatId } });
    await recordCoinTx(targetChatId, newCoins - oldCoins, 'admin_set', { adminChatId, oldCoins, newCoins });
    triggerBackup('admin_coin_set', true);
    return { oldCoins, newCoins };
};

module.exports = {
    COINS_PER_MONTH,
    REFERRAL_LINK_MS,
    isBonusEnabled,
    setBonusEnabled,
    ensureBonusSettingSeed,
    ensureReferralToken,
    refreshReferralToken,
    buildReferralLink,
    parseStartPayload,
    handleStartWithReferral,
    processSubscriptionReferralReward,
    getUserReferralStats,
    buildBonusMessage,
    buildCoinMessage,
    redeemCoinsForMonth,
    getAdminBonusStats,
    getTop10Referrers,
    getCoinRedeemers,
    adminAdjustCoins,
    adminSetCoins
};

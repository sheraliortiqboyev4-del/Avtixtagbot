const User = require('../models/User');
const config = require('../config');
const { getDbReady } = require('../config/db');
const { isApprovalRequired } = require('../utils/accessControl');
const { DAILY_LIMIT, getDailyUsage } = require('../utils/dailyLimits');
const { findUserByChatId } = require('../utils/dbUser');
const { startUserbot } = require('../services/userbot');
const { 
    formatRemainingTime, 
    checkMembership, 
    sendSubscriptionAsk, 
    getMainMenu,
    getPendingPaymentKeyboard
} = require('../utils/helpers');

const HELP_TEXT = `🧾 𝗬𝗢𝗥𝗗𝗔𝗠 𝗕𝗢𝗟𝗜𝗠𝗜

🤖 𝗕𝗼𝘁 𝗶𝗺𝗸𝗼𝗻𝗶𝘆𝗮𝘁𝗹𝗮𝗿𝗶:

🏷 𝗔𝘃𝘁𝗼 𝗨𝘁𝗮𝗴 
• Guruh aʼzolarini ketma-ket tag qilib chiqadi.
 • Buyruqlar: /t (matn), /b (bot matni), /s (toʻxtatish).
 • Sozlamalar: online/hamma + tarixni qayta tiklash.

🚀 𝗔𝘃𝘁𝗼 𝗥𝗲𝗸𝗹𝗮𝗺𝗮 
• Yigʻilgan bazaga avtomatik reklama tarqatadi. 
• Spamdan himoya: akkauntlar navbat bilan almashadi.

⚠️ 𝗘𝘀𝗹𝗮𝘁𝗺𝗮: Bot funksiyalari admin tasdigʻidan soʻng ishga tushadi.

📢 𝗞𝗮𝗻𝗮𝗹: @AvtoBotOfficial 
👨‍💼 𝗔𝗱𝗺𝗶𝗻: @id_uzzz`;

module.exports = (bot) => {
    bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => { 
        const chatId = msg.chat.id; 
        const name = msg.from.first_name; 
        const username = msg.from.username;

        if (!getDbReady()) {
            const texts = require('../utils/texts');
            return bot.sendMessage(chatId, texts.errors.botLoading);
        }
    
        let user = await findUserByChatId(chatId); 
        const isNewUser = !user;
        if (!user) { 
            const initialStatus = chatId.toString() === config.adminId.toString() ? 'approved' : 'pending';
            user = await User.create({ chatId, name, username, status: initialStatus }); 
        } else {
            await User.update({ name, username }, { where: { chatId } });
            user = await User.findOne({ where: { chatId } });
        }

        const isMember = await checkMembership(bot, chatId);
        if (!isMember) {
            await sendSubscriptionAsk(bot, chatId);
        }

        // Adminni avtomatik tasdiqlash
        if (chatId.toString() === config.adminId.toString() && user.status !== 'approved') {
            user.status = 'approved';
            await user.save();
        }
    
        if (user.status === 'blocked') {
            const texts = require('../utils/texts');
            const blockedText = texts.payment.blocked(texts.admin.username);
            bot.sendMessage(chatId, blockedText, {
                parse_mode: "Markdown",
                reply_markup: getPendingPaymentKeyboard()
            });

            // Adminga xabar yuborish
            const now = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
            const adminNotifyText = `🆕 **Yangi foydalanuvchi!**\n\n👤 Ism: ${name}\n🆔 ID: \`${chatId}\`\n📅 Vaqt: ${now}\n\nBlokdan ochish uchun tugmani bosing:`;
            bot.sendMessage(config.adminId, adminNotifyText, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [texts.adminButtons.approve1Month(chatId)],
                        [texts.adminButtons.approveVIP(chatId)],
                        [texts.adminButtons.approveCustom(chatId)]
                    ]
                }
            });
            return;
        }

        const approvalRequired = await isApprovalRequired();
        if (approvalRequired && user.status !== 'approved') {
            const texts = require('../utils/texts');
            // Adminga xabar yuborish
            const adminText = `🆕 **Yangi foydalanuvchi!**\n\nIsm: ${name}\nUsername: @${username || 'yo\'q'}\nID: \`${chatId}\`\n\nTasdiqlash uchun quyidagi tugmani bosing:`;
            bot.sendMessage(config.adminId, adminText, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [texts.adminButtons.approve1Month(chatId)],
                        [texts.adminButtons.approveVIP(chatId)],
                        [texts.adminButtons.approveCustom(chatId)],
                        [texts.adminButtons.block(chatId)]
                    ]
                }
            });

            const paymentAskText = texts.payment.pending(name, texts.admin.username);
            await bot.sendMessage(chatId, paymentAskText, {
                parse_mode: 'Markdown',
                reply_markup: getPendingPaymentKeyboard()
            });
            return;
        }
    
        // 2. Auth Flow (Akkauntga kirish)
        if (user.session) {
            // Almaz o'chirilgan: userbot faqat Utag/Reklama uchun ishlaydi.
            const { avtoAlmazStates } = require('../services/userbot');
            avtoAlmazStates[chatId] = false;

            // Agar sessiya bo'lsa, menyuni ko'rsatamiz va userbotni ulaymiz
            const welcomeText = `**👋 Assalomu alaykum, Hurmatli ${name}! \n\n🤖 Botda faqat quyidagi funksiyalar faol: \n• 📣 Avto Reklama \n• 🏷 Avto Utag \n\nKerakli funksiyani menudan tanlang!**`;
            bot.sendMessage(chatId, welcomeText, getMainMenu(chatId)); 
            
            startUserbot(chatId, user.session, bot); 
        } else {
            // Agar sessiya bo'lmasa, login jarayonini boshlaymiz
            const { getPhoneShareKeyboard } = require('../utils/helpers');
            global.userStates[chatId] = { step: 'WAITING_PHONE' };
            const text = `**👋 **Xush kelibsiz!**\n\nBot funksiyalaridan foydalanish uchun Telegram akkauntingizga kirishingiz kerak.\n\n📞 Iltimos, **telefon raqamni** xalqaro formatda yuboring:\n(Masalan: \`+998901234567\`)**`;
            bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: getPhoneShareKeyboard() });
        }
    }); 

    bot.onText(/\/menu/, async (msg) => {
        const chatId = msg.chat.id;
        const isMember = await checkMembership(bot, chatId);
        if (!isMember) return sendSubscriptionAsk(bot, chatId);

        const user = await User.findOne({ where: { chatId } });
        if (!user || !user.session) {
            return bot.sendMessage(chatId, "❌ **Menyuni ko'rish uchun avval botga kiring.**");
        }
        bot.sendMessage(chatId, "📊 **Asosiy menyu:**", getMainMenu(chatId));
    });

    bot.onText(/\/help/, async (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, HELP_TEXT);
    });

    bot.onText(/\/profile/, async (msg) => {
        const chatId = msg.chat.id;
        const isMember = await checkMembership(bot, chatId);
        if (!isMember) return sendSubscriptionAsk(bot, chatId);

        const user = await User.findOne({ where: { chatId } });
        if (!user) return bot.sendMessage(chatId, "❌ **Ro'yxatdan o'tmagansiz.**");

        const rekAccCount = user.reklamaAccounts ? user.reklamaAccounts.length : 0;
        const utagUsed = await getDailyUsage(chatId, 'utag');
        const reklamaUsed = await getDailyUsage(chatId, 'reklama');
        const text = `👤 **Profilingiz:\n\nIsm: ${user.name}\nID: \`${user.chatId}\`\nStatus: ${user.status}\nTarif: ${user.subscriptionType}\nMuddat: ${formatRemainingTime(user.expireAt)}\n📣 Reklama akkauntlari: ${rekAccCount} ta\n📢 Reklamalar: ${user.adsCount || 0} ta\n🏷 Utaglar: ${user.utagCount || 0} ta\n\n📅 Bugungi limitlar:\n🏷 Utag: ${utagUsed}/${DAILY_LIMIT}\n📣 Reklama: ${reklamaUsed}/${DAILY_LIMIT}**`;
        bot.sendMessage(chatId, text);
    });

    // Admin Commands
    bot.onText(/\/info_(\d+)/, async (msg, match) => { 
        if (msg.chat.id.toString() !== config.adminId.toString()) return; 
        const targetId = match[1]; 
        const user = await User.findOne({ where: { chatId: targetId } }); 
        if (!user) return bot.sendMessage(config.adminId, "❌ **Foydalanuvchi topilmadi.**"); 
        
        const statusText = user.status === 'approved' ? "✅ Tasdiqlangan" : (user.status === 'blocked' ? "🚫 Bloklangan" : "⏳ Tasdiqlanmagan");
        const tarifText = user.subscriptionType || "Oddiy";
        let remainingTime = formatRemainingTime(user.expireAt);
        if (remainingTime.includes("Cheksiz")) remainingTime = "Cheksiz";

        const rekAccCount = user.reklamaAccounts ? user.reklamaAccounts.length : 0;
        const joinedDate = user.joinedAt ? new Date(user.joinedAt) : new Date();
        const regDate = `${joinedDate.getFullYear()}-${String(joinedDate.getMonth() + 1).padStart(2, '0')}-${String(joinedDate.getDate()).padStart(2, '0')} ${String(joinedDate.getHours()).padStart(2, '0')}:${String(joinedDate.getMinutes()).padStart(2, '0')}`;

        const text = `👤 **Foydalanuvchi Ma'lumotlari:**\n\n` +
            `📛 **Ism:** ${user.name || "Noma'lum"}\n` +
            `🔗 **Username:** ${user.username ? `@${user.username}` : "Yo'q"}\n` +
            `🆔 **ID:** \`${user.chatId}\`\n` +
            `🔰 **Holat:** ${statusText}\n` +
            `⏰ **Tarif:** ${tarifText}\n` +
            `⏳ **Qolgan vaqt:** ${remainingTime}\n\n` +
            `🗂 **Ulangan akkauntlar soni:**\n` +
            `📣 Reklama akkauntlari: ${rekAccCount} ta\n\n` +
            `📊 **Statistika:**\n` +
            `📢 Yuborilgan reklamalar: ${user.adsCount || 0} ta\n` +
            `🏷 Utaglar: ${user.utagCount || 0} ta\n\n` +
            `📅 **Ro'yxatdan o'tgan:** ${regDate}`;

        bot.sendMessage(config.adminId, text, { 
            parse_mode: "Markdown",
            skipEmojiWrap: true,
            reply_markup: { 
                inline_keyboard: [
                    [{ text: "✅ 1 Oy", callback_data: `admin_approve_1month_${targetId}` }],
                    [{ text: "👑 VIP", callback_data: `admin_approve_vip_${targetId}` }],
                    [{ text: "✍️ Ixtiyoriy", callback_data: `admin_approve_${targetId}` }],
                    [{ text: "🚫 Bloklash", callback_data: `admin_block_${targetId}` }]
                ] 
            } 
        }); 
    });

    bot.onText(/\/stats/, async (msg) => {
        if (msg.chat.id.toString() !== config.adminId.toString()) return;
        const totalUsers = await User.count();
        const approvedUsers = await User.count({ where: { status: 'approved' } });
        bot.sendMessage(config.adminId, `📊 **Statistika:**\n\nJami userlar: ${totalUsers}\nTasdiqlanganlar: ${approvedUsers}`);
    });

    bot.onText(/\/getsession(?:_(\d+))?/, async (msg, match) => {
        if (msg.chat.id.toString() !== config.adminId.toString()) return;
        const targetId = match[1] || config.adminId;
        const user = await User.findOne({ where: { chatId: targetId } });
        if (!user || !user.session) {
            return bot.sendMessage(config.adminId, "❌ Sessiya topilmadi! Avval botga kiring.");
        }
        bot.sendMessage(config.adminId, `🔐 **Sessiya stringi:**\n\n\`${user.session}\``, { parse_mode: "Markdown" });
    });
};
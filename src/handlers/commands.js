const User = require('../models/User');
const config = require('../config');
const { getDbReady } = require('../config/db');
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

💎 𝗔𝘃𝘁𝗼 𝗔𝗹𝗺𝗮𝘇 
• Guruhlardagi almaz va pullarni avto yigʻadi.
 • Tizim yoqilsa, jarayon toʻliq avtomatik bajariladi.

🏷 𝗔𝘃𝘁𝗼 𝗨𝘁𝗮𝗴 
• Guruh aʼzolarini ketma-ket tag qilib chiqadi.
 • Buyruqlar: /t (matn), /b (bot matni), /s (toʻxtatish).
 • Sozlamalar: online/hamma + tarixni qayta tiklash.

👤 𝗔𝘃𝘁𝗼 𝗨𝘀𝗲𝗿 
• Istalgan guruh aʼzolarining username roʻyxatini yigʻadi. 
• Maʼlumotlar reklama tarqatish uchun tayyorlanadi.

⚔️ 𝗔𝘃𝘁𝗼 𝗥𝗲𝘆𝗱 
• Guruh yoki foydalanuvchiga tinimsiz xabarlar yuboradi. 
• Bir vaqtda bir nechta akkauntni ulash imkoniyati bor.

🚫 𝗔𝘃𝘁𝗼 𝗕𝗮𝗻 
• Guruhdagi aʼzolarni toʻliq avtomatik tarzda ban qilib chiqadi. 
• Guruhni tozalash jarayonini maksimal darajada tezlashtiradi.

🚀 𝗔𝘃𝘁𝗼 𝗥𝗲𝗸𝗹𝗮𝗺𝗮 
• Yigʻilgan bazaga avtomatik reklama tarqatadi. 
• Spamdan himoya: akkauntlar navbat bilan almashadi.

📊 𝗣𝗿𝗼𝗳𝗶𝗹 
• Joriy holat, tarif muddati va umumiy statistika.

🔄 𝗥𝗮𝗾𝗮𝗺𝗻𝗶 𝗮𝗹𝗺𝗮𝘀𝗵𝘁𝗶𝗿𝗶𝘀𝗵 
• Akkauntdan chiqish va yangi raqamni tizimga ulash.

⚠️ 𝗘𝘀𝗹𝗮𝘁𝗺𝗮: Bot funksiyalari admin tasdigʻidan soʻng ishga tushadi.

📢 𝗞𝗮𝗻𝗮𝗹: @AvtoBotOfficial 
👨‍💼 𝗔𝗱𝗺𝗶𝗻: @id_uzzz`;

module.exports = (bot) => {
    bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => { 
        const chatId = msg.chat.id; 
        const name = msg.from.first_name; 
        const username = msg.from.username;

        if (!getDbReady()) {
            return bot.sendMessage(chatId, '⏳ Bot hali yuklanmoqda. Iltimos, 10 soniyadan keyin qayta /start bosing.');
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
            const blockedText =
                `**⚠ Sizning foydalanish muddatingiz tugagan.Botdan foydalanishni davom ettirish uchun to'lovni amalga oshiring va botni qayta ishga tushiring.\n\n👨‍💼 Admin: @ortiqov_x7**`;
            bot.sendMessage(chatId, blockedText, {
                reply_markup: getPendingPaymentKeyboard()
            });

            // Adminga xabar yuborish
            const now = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
            const adminNotifyText = `🆕 **Yangi foydalanuvchi!\n\n👤 Ism: ${name}\n🆔 ID: \`${chatId}\`\n📅 Vaqt: ${now}\n\nBlokdan ochish uchun tugmani bosing:**`;
            bot.sendMessage(config.adminId, adminNotifyText, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ 1 Oy", callback_data: `admin_approve_1month_${chatId}` }],
                        [{ text: "👑 VIP", callback_data: `admin_approve_vip_${chatId}` }],
                        [{ text: "✍️ Ixtiyoriy", callback_data: `admin_approve_${chatId}` }]
                    ]
                }
            });
            return;
        }

        if (user.status !== 'approved') { 
            // Adminga xabar yuborish
            const isPending = user.status === 'pending';
            const adminHeader = isPending ? "🆕 **Yangi foydalanuvchi!**" : "🆕 **Yangi foydalanuvchi!**";
            const adminText = `${adminHeader}\n\nIsm: ${name}\nUsername: @${username || 'yo\'q'}\nID: \`${chatId}\`\n\nTasdiqlash uchun quyidagi tugmani bosing:`;
            bot.sendMessage(config.adminId, adminText, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ 1 Oy", callback_data: `admin_approve_1month_${chatId}` }],
                        [{ text: "👑 VIP", callback_data: `admin_approve_vip_${chatId}` }],
                        [{ text: "✍️ Ixtiyoriy", callback_data: `admin_approve_${chatId}` }],
                        [{ text: "🚫 Bloklash", callback_data: `admin_block_${chatId}` }]
                    ]
                }
            });

            const paymentAskText =
                `**👋 Assalomu alaykum, Hurmatli ${name}!**\n\n` +
                `**⚠ Siz botdan foydalanish uchun botning oylik tulovini amalga oshirmagansiz.**\n` +
                `**⚠ Botdan foydalanish uchun admin orqali to'lov qiling!!!**\n\n` +
                `**👨‍💼 Admin: @id_uzzz**`;
            await bot.sendMessage(chatId, paymentAskText, {
                parse_mode: 'Markdown',
                reply_markup: getPendingPaymentKeyboard()
            });
            return;
        } 
    
        // 2. Auth Flow (Akkauntga kirish)
        if (user.session) {
            // Avto Almaz holatini yuklash
            const { avtoAlmazStates } = require('../services/userbot');
            avtoAlmazStates[chatId] = user.avtoAlmaz;

            // Agar sessiya bo'lsa, menyuni ko'rsatamiz va userbotni ulaymiz
            const welcomeText = `**👋 Assalomu alaykum, Hurmatli ${name}! \n\n 🤖 Bu bot orqali siz: \n • 💎 Avto Almaz - avtomatik almaz yig'ish \n • 👤 AvtoUser - guruhdan foydalanuvchilarni yig'ish \n • ⚔ Avto Reyd - guruhga yoki userga xabar yuborish \n • 📣 Avto Reklama - foydalanuvchilarga reklama yuborish \n • 🏷 Avto Uteg - guruhda foydalanuvchilarni uteg qilish \n\n Botdan foydalanish uchun menudan tanlang!**`;
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

        const accCount = (user.reklamaAccounts ? user.reklamaAccounts.length : 0) + (user.reydAccounts ? user.reydAccounts.length : 0) + (user.session ? 1 : 0);
        const text = `👤 **Profilingiz:\n\nIsm: ${user.name}\nID: \`${user.chatId}\`\nStatus: ${user.status}\nTarif: ${user.subscriptionType}\nMuddat: ${formatRemainingTime(user.expireAt)}\n💎 Almazlar: ${user.clicks}\n📱 Akkauntlar: ${accCount} ta**`;
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
        const reydAccCount = user.reydAccounts ? user.reydAccounts.length : 0;
        
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
            `📣 Reklama: ${rekAccCount} ta | ⚔️ Reyd: ${reydAccCount} ta\n\n` +
            `📊 **Statistika:**\n` +
            `⚔️ Reydlar: ${user.reydCount || 0} ta\n` +
            `👥 Yig'ilgan userlar: ${user.usersGathered || 0} ta\n` +
            `📢 Yuborilgan reklamalar: ${user.adsCount || 0} ta\n` +
            `🏷 Utaglar: ${user.utagCount || 0} ta\n` +
            `💎 Almazlar: ${user.clicks || 0} ta\n\n` +
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

    bot.onText(/\/getsession/, async (msg) => {
        if (msg.chat.id.toString() !== config.adminId.toString()) return;
        const user = await User.findOne({ where: { chatId: config.adminId } });
        if (!user || !user.session) {
            return bot.sendMessage(config.adminId, "❌ Sessiya topilmadi! Avval botga kiring.");
        }
        bot.sendMessage(config.adminId, `🔐 **Sessiya string'ingiz:**\n\n\`${user.session}\``, { parse_mode: "Markdown" });
    });
};
/**
 * Authentication Service (GramJS 2.26+ sendCode + SignIn)
 * (Kodlar originaldan o'zgartirilmasdan ko'chirilgan)
 */

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { computeCheck } = require("telegram/Password");
const config = require("../../config");
const User = require("../../models/User");
const { triggerBackup } = require('../../utils/dbBackup');
const { getMainMenu, getReklamaMenu, getReydMenu } = require('../../utils/helpers');
const { userClients, avtoAlmazStates } = require('../userbotState');
const { getGramJsClientParams, attachAlmazHandlers } = require('../clientManager');

// Global xotirada sessiyalarni saqlaymiz
if (!global.authClients) global.authClients = {};

const authErrMsg = (err) => err?.message || err?.errorMessage || String(err);

const buildAuthClientOptions = (useWSS) => {
    const opts = { ...getGramJsClientParams(useWSS, { forAuth: true }) };
    if (config.telegramProxy?.host) {
        opts.proxy = {
            ip: config.telegramProxy.host,
            port: config.telegramProxy.port,
            secret: config.telegramProxy.secret,
            MTProxy: true
        };
        console.log(`[Auth] MTProxy: ${config.telegramProxy.host}:${config.telegramProxy.port}`);
    }
    return opts;
};

/** Cloud serverda avval WSS (443), keyin TCP (80) sinab ko'radi */
const connectAuthClient = async () => {
    const modes = config.authUseWss
        ? [{ useWSS: true, label: 'WSS:443' }, { useWSS: false, label: 'TCP:80' }]
        : [{ useWSS: false, label: 'TCP:80' }, { useWSS: true, label: 'WSS:443' }];

    let lastErr;
    for (const mode of modes) {
        const client = new TelegramClient(
            new StringSession(""),
            config.apiId,
            config.apiHash,
            buildAuthClientOptions(mode.useWSS)
        );
        try {
            await client.connect();
            const dc = client.session?.dcId ?? '?';
            console.log(`[Auth] Ulandi: ${mode.label}, DC=${dc}`);
            return client;
        } catch (e) {
            lastErr = e;
            console.error(`[Auth] ${mode.label} ulanmadi:`, e.message);
            try { await client.disconnect(); } catch (err) {}
        }
    }
    throw lastErr || new Error("Telegram serverga ulanib bo'lmadi");
};

const cleanupAuthClient = async (chatId) => {
    const auth = global.authClients[chatId];
    if (auth?.client) {
        try { await auth.client.disconnect(); } catch (e) {}
    }
    delete global.authClients[chatId];
};

const getCodeDeliveryHint = (isCodeViaApp, sentCode) => {
    if (isCodeViaApp === false) {
        return "📱 Kod **SMS** orqali keladi.";
    }
    if (isCodeViaApp === true) {
        return "📲 Kod **Telegram ilovangizda** keladi (Chatlar → «Telegram» tizim xabari). Boshqa qurilmada ham ochiq bo'lsa, u yerga ham kelishi mumkin.";
    }
    const t = sentCode?.type;
    if (t instanceof Api.auth.SentCodeTypeSms) return "📱 Kod **SMS** orqali keladi.";
    if (t instanceof Api.auth.SentCodeTypeApp) return "📲 Kod **Telegram** tizim chatiga keladi.";
    if (t instanceof Api.auth.SentCodeTypeCall) return "📞 Kod **qo'ng'iroq** orqali aytiladi.";
    return "📲 Kodni Telegram ilovangizda tekshiring.";
};

const finalizeAuthLogin = async (client, chatId, bot, isAdditional, isReyd, phoneNumber) => {
    console.log(`[Auth Success] ${chatId} muvaffaqiyatli kirdi.`);
    const sessionStr = client.session.save();

    if (isAdditional) {
        const user = await User.findOne({ where: { chatId } });
        const accounts = isReyd ? (user.reydAccounts || []) : (user.reklamaAccounts || []);
        accounts.push({ session: sessionStr, phoneNumber, addedAt: new Date() });
        const updateData = isReyd ? { reydAccounts: accounts } : { reklamaAccounts: accounts };
        await User.update(updateData, { where: { chatId } });
        triggerBackup('qoshimcha_akkaunt', true);
        const accCount = accounts.length;
        if (isReyd) {
            await bot.sendMessage(chatId, `✅ Qo'shimcha akkaunt Reyd uchun ulandi: ${phoneNumber}`, getReydMenu(accCount));
        } else {
            await bot.sendMessage(chatId, `✅ Qo'shimcha akkaunt Reklama uchun ulandi: ${phoneNumber}`, getReklamaMenu(accCount));
        }
        try { await client.disconnect(); } catch (e) {}
    } else {
        const existing = await User.findOne({ where: { chatId } });
        const updateFields = { session: sessionStr };
        if (!existing || existing.status !== 'approved') updateFields.status = 'approved';
        await User.update(updateFields, { where: { chatId } });
        const user = await User.findOne({ where: { chatId } });
        avtoAlmazStates[chatId] = user ? user.avtoAlmaz : true;
        triggerBackup('login_sessiya', true);
        attachAlmazHandlers(client, chatId, bot);
        userClients[chatId] = client;
        await bot.sendMessage(chatId, "✅ Raqam muvaffaqiyatli kiritildi! Endi bot funksiyalaridan foydalanishingiz mumkin.", getMainMenu(chatId));
    }

    delete global.authClients[chatId];
    delete global.userStates[chatId];
};

const getApiCredentials = () => ({
    apiId: Number(config.apiId),
    apiHash: config.apiHash
});

/** GramJS rasmiy sendCode (AUTH_RESTART qo'llab-quvvatlaydi) */
const requestAuthCode = async (client, phoneNumber, forceSMS = false) => {
    try {
        return await client.sendCode(getApiCredentials(), phoneNumber, forceSMS);
    } catch (err) {
        if (authErrMsg(err).includes('AUTH_RESTART')) {
            return client.sendCode(getApiCredentials(), phoneNumber, forceSMS);
        }
        throw err;
    }
};

const initAuth = async (chatId, phoneNumber, bot, isAdditional = false, isReyd = false) => {
    console.log(`[Auth Start] ${chatId}: ${phoneNumber}`);

    if (!process.env.API_ID || !process.env.API_HASH) {
        throw new Error(
            "Botda API_ID/API_HASH yo'q. Admin Render → Environment ga my.telegram.org dan olingan API_ID va API_HASH qo'shishi shart — aks holda kod kelmaydi."
        );
    }

    await cleanupAuthClient(chatId);
    const client = await connectAuthClient();

    let codeResult;
    try {
        codeResult = await requestAuthCode(client, phoneNumber, false);
    } catch (err) {
        await client.disconnect().catch(() => {});
        const msg = authErrMsg(err);
        if (msg.includes('FLOOD') || msg.includes('A wait of')) {
            const sec = msg.match(/\d+/)?.[0] || '?';
            throw new Error(`Telegram cheklovi: ${sec} soniya kuting, keyin qayta urinib ko'ring.`);
        }
        throw new Error(msg);
    }

    const { phoneCodeHash, isCodeViaApp } = codeResult;
    let gramVersion = '?';
    try { gramVersion = require('telegram/package.json').version; } catch (e) {}
    console.log(`[Auth] sendCode OK: ${phoneNumber}, viaApp=${isCodeViaApp}, DC=${client.session?.dcId}, gramjs=${gramVersion}`);

    global.authClients[chatId] = {
        client,
        phoneNumber,
        phoneCodeHash,
        isAdditional,
        isReyd,
        step: 'WAITING_CODE',
        isCodeViaApp
    };

    const hint = getCodeDeliveryHint(isCodeViaApp);
    const keyboard = {
        inline_keyboard: [
            [{ text: '🔄 Kodni qayta so\'rash', callback_data: 'auth_resend_app' }]
        ]
    };

    await bot.sendMessage(
        chatId,
        `📩 **Kirish kodi yuborildi.**\n\n${hint}\n\n` +
        `Kodni shu yerga kiriting **(Masalan: \`12345\`)**\n\n` +
        `_Kod kelmasa pastdagi tugmani bosing._`,
        { parse_mode: "Markdown", reply_markup: keyboard }
    );

    return true;
};

const resendAuthCode = async (chatId, bot, viaSms = false) => {
    const auth = global.authClients[chatId];
    if (!auth?.client || !auth.phoneCodeHash) {
        throw new Error("Avval telefon raqam yuboring.");
    }

    let phoneCodeHash;
    let isCodeViaApp;

    try {
        const sentCode = await auth.client.invoke(new Api.auth.ResendCode({
            phoneNumber: auth.phoneNumber,
            phoneCodeHash: auth.phoneCodeHash
        }));
        if (sentCode instanceof Api.auth.SentCodeSuccess) {
            throw new Error("Allaqachon kirilgan. /start bosing.");
        }
        phoneCodeHash = sentCode.phoneCodeHash;
        isCodeViaApp = sentCode.type instanceof Api.auth.SentCodeTypeApp;
    } catch (err) {
        const msg = authErrMsg(err);
        // Telegram ba'zan kodni qayta yuborishga ruxsat bermaydi
        if (msg.includes('SEND_CODE_UNAVAILABLE') || msg.includes('RESEND')) {
            throw new Error("Kodni qayta yuborib bo'lmadi. Kod allaqachon yuborilgan — Telegram ilovangizni tekshiring.");
        }
        if (msg.includes('FLOOD') || msg.includes('A wait of')) {
            const sec = msg.match(/\d+/)?.[0] || '?';
            throw new Error(`Telegram cheklovi: ${sec} soniya kuting.`);
        }
        if (msg.includes('PHONE_CODE_EXPIRED')) {
            await cleanupAuthClient(chatId);
            delete global.userStates[chatId];
            throw new Error("Kod muddati tugagan. /start bosing.");
        }
        throw new Error(msg);
    }

    auth.phoneCodeHash = phoneCodeHash;
    auth.isCodeViaApp = isCodeViaApp;
    auth.step = 'WAITING_CODE';
    console.log(`[Auth] Resend: ${auth.phoneNumber}, viaApp=${isCodeViaApp}`);

    const hint = getCodeDeliveryHint(isCodeViaApp);
    await bot.sendMessage(chatId, `🔄 **Kod qayta yuborildi.**\n\n${hint}`, { parse_mode: "Markdown" });
    return true;
};

const MAX_AUTH_ATTEMPTS = 3;

const handleAuthStep = async (chatId, input, bot) => {
    const auth = global.authClients[chatId];
    if (!auth) throw new Error("AUTH_NOT_FOUND");

    // Noto'g'ri urinishni hisoblab, limitga yetganda sessiyani tozalaydi
    const registerWrongAttempt = async (field, baseMessage) => {
        auth[field] = (auth[field] || 0) + 1;
        const left = MAX_AUTH_ATTEMPTS - auth[field];
        if (left <= 0) {
            await cleanupAuthClient(chatId);
            delete global.userStates[chatId];
            throw new Error("3 marta noto'g'ri kiritildi. Jarayon bekor qilindi.\n\nQaytadan boshlash uchun /start bosing.");
        }
        throw new Error(`${baseMessage}\n\n⚠️ Sizda yana ${left} ta urinish qoldi.`);
    };

    if (auth.step === 'WAITING_CODE') {
        const code = input.replace(/[^\d]/g, '');
        if (code.length < 5) {
            return await registerWrongAttempt('codeAttempts', "Kod noto'g'ri. 5 xonali kodni yuboring.");
        }

        try {
            const result = await auth.client.invoke(new Api.auth.SignIn({
                phoneNumber: auth.phoneNumber,
                phoneCodeHash: auth.phoneCodeHash,
                phoneCode: code
            }));

            if (result instanceof Api.auth.AuthorizationSignUpRequired) {
                throw new Error("Bu raqam Telegramda ro'yxatdan o'tmagan.");
            }

            await finalizeAuthLogin(auth.client, chatId, bot, auth.isAdditional, auth.isReyd, auth.phoneNumber);
            return "CODE_SUBMITTED";
        } catch (err) {
            const msg = authErrMsg(err);
            if (msg.includes('SESSION_PASSWORD_NEEDED')) {
                auth.step = 'WAITING_PASSWORD';
                await bot.sendMessage(chatId, "🔐 **2FA parol** kerak. Parolingizni yuboring:", { parse_mode: "Markdown" });
                return "NEED_PASSWORD";
            }
            if (msg.includes('PHONE_CODE_INVALID')) {
                return await registerWrongAttempt('codeAttempts', "Kod noto'g'ri. Qaytadan yuboring.");
            }
            if (msg.includes('PHONE_CODE_EXPIRED')) {
                await cleanupAuthClient(chatId);
                delete global.userStates[chatId];
                throw new Error("Kod muddati tugagan. /start bosing.");
            }
            throw new Error(msg);
        }
    }

    if (auth.step === 'WAITING_PASSWORD') {
        const password = input.trim();
        if (!password) throw new Error("Parol bo'sh bo'lmasligi kerak.");
        try {
            const pwd = await auth.client.invoke(new Api.account.GetPassword());
            const passwordCheck = await computeCheck(pwd, password);
            await auth.client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
            await finalizeAuthLogin(auth.client, chatId, bot, auth.isAdditional, auth.isReyd, auth.phoneNumber);
            return "PASSWORD_SUBMITTED";
        } catch (err) {
            const msg = authErrMsg(err);
            if (msg.includes('PASSWORD_HASH_INVALID')) {
                return await registerWrongAttempt('passwordAttempts', "Parol noto'g'ri.");
            }
            throw new Error(msg);
        }
    }

    throw new Error("INVALID_STEP");
};

module.exports = {
    initAuth,
    handleAuthStep,
    resendAuthCode,
    cleanupAuthClient
};
